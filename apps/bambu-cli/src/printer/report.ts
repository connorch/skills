// Parse read-only MQTT reports into JSON-ready printer snapshots and Slots.
export function mapping(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function mappings(value: unknown) {
  return Array.isArray(value) ? value.map(mapping).filter((v) => Object.keys(v).length) : [];
}
export function count(value: unknown): number | null {
  if (typeof value !== "number" && !(typeof value === "string" && /^-?\d+$/.test(value.trim())))
    return null;
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function temperature(value: unknown) {
  if ((typeof value !== "number" && typeof value !== "string") || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}
function hex(n: number, width = 4) {
  return n.toString(16).toUpperCase().padStart(width, "0");
}
export interface Slot {
  unit: number | null;
  slot: number;
  material: string;
  name: string;
  color: string;
  remaining_pct: number | null;
  active: boolean;
}
export function parseTrays(report: Record<string, unknown>): Slot[] {
  const ams = mapping(report.ams),
    feeding = count(ams.tray_now);
  function slot(
    raw: Record<string, unknown>,
    unit: number | null,
    position: number,
    feed: number,
  ): Slot {
    const color = String(raw.tray_color || ""),
      remaining = count(raw.remain);
    return {
      unit,
      slot: position,
      material: String(raw.tray_type || ""),
      name: String(raw.tray_sub_brands || ""),
      color: /^(?:[\da-f]{6}|[\da-f]{8})$/i.test(color)
        ? `#${color.slice(0, 6).toUpperCase()}`
        : "",
      remaining_pct: remaining !== null && remaining <= 100 ? remaining : null,
      active: feeding === feed,
    };
  }
  const slots: Slot[] = [];
  for (const unit of mappings(ams.ams)) {
    const id = count(unit.id);
    if (id === null) continue;
    for (const raw of mappings(unit.tray)) {
      const position = count(raw.id);
      if (position !== null && raw.tray_type)
        slots.push(slot(raw, id, position, id >= 128 ? id : id * 4 + position));
    }
  }
  const external = mapping(report.vt_tray);
  if (external.tray_type) slots.push(slot(external, null, 0, 254));
  return slots;
}
export function parseStatus(report: Record<string, unknown>) {
  const state = String(report.gcode_state || "UNKNOWN").toUpperCase(),
    error = count(report.print_error);
  const light = mappings(report.lights_report).find((v) => v.node === "chamber_light");
  return {
    state,
    active: ["PREPARE", "SLICING", "RUNNING", "PAUSE"].includes(state),
    progress_pct: count(report.mc_percent),
    remaining_min: count(report.mc_remaining_time),
    layer: count(report.layer_num),
    total_layers: count(report.total_layer_num),
    file: String(report.subtask_name || report.gcode_file || ""),
    nozzle_temp: temperature(report.nozzle_temper),
    nozzle_target: temperature(report.nozzle_target_temper),
    bed_temp: temperature(report.bed_temper),
    bed_target: temperature(report.bed_target_temper),
    chamber_temp: temperature(report.chamber_temper),
    speed: [null, "silent", "standard", "sport", "ludicrous"][count(report.spd_lvl) ?? 0] ?? null,
    light: light?.mode ? String(light.mode) : null,
    print_error: error ? hex(error, 8) : null,
    hms: mappings(report.hms).flatMap((v) => {
      const attr = count(v.attr),
        code = count(v.code);
      return attr === null || code === null
        ? []
        : [
            `${hex(Math.floor(attr / 65536))}_${hex(attr % 65536)}_${hex(Math.floor(code / 65536))}_${hex(code % 65536)}`,
          ];
    }),
    trays: parseTrays(report),
  };
}
export type PrinterStatus = ReturnType<typeof parseStatus>;
export function trayLabel(slot: Slot) {
  return slot.unit === null
    ? "Ext"
    : slot.unit >= 128
      ? `HT${slot.unit - 127}`
      : `${String.fromCharCode(65 + slot.unit)}${slot.slot + 1}`;
}
export function formatTray(slot: Slot) {
  return [
    `${slot.active ? "▶ " : "  "}${trayLabel(slot)}`,
    slot.name || slot.material || "?",
    slot.color || "colour unknown",
    ...(slot.remaining_pct === null ? [] : [`${slot.remaining_pct}% left`]),
  ].join("  ");
}
export function formatTrays(slots: Slot[]) {
  return slots.length
    ? `Filament (▶ = feeding):\n${slots.map(formatTray).join("\n")}`
    : "Filament: no AMS or spool information reported";
}
export function formatMinutes(minutes: number) {
  const h = Math.floor(minutes / 60),
    m = minutes % 60;
  return h ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
}
export function formatTemp(current: number | null, target: number | null) {
  return current === null
    ? "-"
    : `${current.toFixed(0)}${target ? `/${target.toFixed(0)}` : ""} °C`;
}
export function formatStatus(s: PrinterStatus, model?: string) {
  const headline = [s.state];
  if (s.active) {
    if (s.progress_pct !== null) headline.push(`${s.progress_pct}%`);
    if (s.layer !== null && s.total_layers) headline.push(`layer ${s.layer}/${s.total_layers}`);
    if (s.remaining_min !== null) headline.push(`${formatMinutes(s.remaining_min)} left`);
  }
  const lines = [`${model || "Printer"}: ${headline.join(" · ")}`];
  if (s.file && s.active) lines.push(`File: ${s.file}`);
  lines.push(
    [
      `Nozzle ${formatTemp(s.nozzle_temp, s.nozzle_target)}`,
      `Bed ${formatTemp(s.bed_temp, s.bed_target)}`,
      ...(s.chamber_temp === null ? [] : [`Chamber ${formatTemp(s.chamber_temp, null)}`]),
    ].join(" · "),
  );
  const extras = [s.speed && `Speed ${s.speed}`, s.light && `Light ${s.light}`].filter(Boolean);
  if (extras.length) lines.push(extras.join(" · "));
  if (s.print_error)
    lines.push(`Printer error ${s.print_error} (details on the printer screen or in Bambu Handy)`);
  if (s.hms.length)
    lines.push(`HMS: ${s.hms.join(", ")} (look the code up in Bambu Handy or wiki.bambulab.com)`);
  lines.push(formatTrays(s.trays));
  return lines.join("\n");
}
