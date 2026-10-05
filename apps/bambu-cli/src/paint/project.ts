import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { z } from "zod";
import profiles from "./data/profiles.json" with { type: "json" };
import template from "./data/project_settings.json" with { type: "json" };
import perFilament from "./data/per_filament_keys.json" with { type: "json" };
import type { Vec3 } from "./lab.ts";
import type { Face } from "./segment.ts";
export function paintCode(filament: number): string {
  if (!Number.isInteger(filament) || filament < 1 || filament > 18)
    throw new RangeError("filament must be between 1 and 18");
  return filament === 1
    ? "4"
    : filament === 2
      ? "8"
      : `${(filament - 3).toString(16).toUpperCase()}C`;
}
export function paintFilament(code: string): number | undefined {
  if (code === "4") return 1;
  if (code === "8") return 2;
  return /^[0-9A-F]C$/.test(code) ? parseInt(code[0]!, 16) + 3 : undefined;
}
// Resize all audited per-filament settings, selecting the configured printer profiles.
export function projectSettings(colours: string[], model = "P1S"): Record<string, unknown> {
  if (!colours.length) throw new RangeError("a project needs at least one filament");
  const aliases: Record<string, string> = { X1C: "X1 Carbon" };
  const family = aliases[model] ?? model;
  const printer = family.startsWith("Bambu Lab ")
    ? family.endsWith(" nozzle")
      ? family
      : `${family} 0.4 nozzle`
    : `Bambu Lab ${family} 0.4 nozzle`;
  const profile = profiles[printer as keyof typeof profiles];
  if (!profile) throw new RangeError(`no recorded 0.4 mm paint profile for ${model}`);
  const settings: Record<string, unknown> = {
      ...structuredClone(template),
      ...structuredClone(profile),
    },
    count = colours.length;
  for (const key of perFilament) {
    const value = z.array(z.unknown()).parse(settings[key]);
    settings[key] = Array.from({ length: count }, () => value[0]);
  }
  settings.filament_colour = colours.map((c) => c.toUpperCase());
  settings.filament_self_index = colours.map((_, i) => String(i + 1));
  settings.filament_map = colours.map(() => "1");
  settings.filament_nozzle_map = colours.map(() => "1");
  settings.filament_volume_map = colours.map(() => "0");
  settings.flush_volumes_matrix = colours.flatMap((_, i) =>
    colours.map((_, j) => (i === j ? "0" : "280")),
  );
  settings.flush_volumes_vector = Array<string>(2 * count).fill("140");
  settings.different_settings_to_system = Array<string>(count + 2).fill("");
  settings.inherits_group = Array<string>(count + 2).fill("");
  const bedBack = Math.max(
    ...z
      .array(z.string())
      .parse(settings.printable_area)
      .map((p) => Number(p.split("x")[1])),
  );
  const towerY = Number(z.array(z.string()).parse(settings.wipe_tower_y)[0]);
  settings.wipe_tower_y = [String(Math.min(towerY, bedBack - 66))];
  return settings;
}
const ns =
  'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p"';
const xml = '<?xml version="1.0" encoding="UTF-8"?>';
function escape(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
function rels(target: string) {
  return `${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="${target}" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
}
export function bounds(vertices: Vec3[]) {
  const low: Vec3 = [Infinity, Infinity, Infinity],
    high: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const v of vertices)
    for (let i = 0; i < 3; i++) {
      low[i] = Math.min(low[i]!, v[i]!);
      high[i] = Math.max(high[i]!, v[i]!);
    }
  return { low, high, size: high.map((v, i) => v - low[i]!) as Vec3 };
}
// A Bambu project uses a production component, whole-triangle paint and a bed-centred build item.
export function buildProject(
  vertices: Vec3[],
  faces: Face[],
  labels: number[],
  colours: string[],
  name: string,
  model = "P1S",
): Uint8Array {
  if (
    !vertices.length ||
    faces.length !== labels.length ||
    labels.some((v) => !Number.isInteger(v) || v < 0 || v >= colours.length)
  )
    throw new RangeError("invalid painted mesh");
  const settings = projectSettings(colours, model),
    { low, high, size } = bounds(vertices);
  const corners = z
    .array(z.string())
    .parse(settings.printable_area)
    .map((p) => p.split("x").map(Number));
  const bed = [0, 1].map(
    (i) => (Math.min(...corners.map((p) => p[i]!)) + Math.max(...corners.map((p) => p[i]!))) / 2,
  );
  const offset = [bed[0]!, bed[1]!, size[2] / 2];
  const root = `${xml}<model unit="millimeter" xml:lang="en-US" ${ns}><metadata name="Application">BambuStudio-02.07.01.62</metadata><metadata name="BambuStudio:3mfVersion">1</metadata><metadata name="Title">${escape(name)}</metadata><resources><object id="2" p:UUID="00000001-61cb-4c03-9d28-80fed5dfa1dc" type="model"><components><component p:path="/3D/Objects/object_1.model" objectid="1" p:UUID="00010000-b206-40ff-9872-83e8017abed1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object></resources><build p:UUID="2c7c17d8-22b5-4d84-8835-1976022ea369"><item objectid="2" p:UUID="00000002-b1ec-4553-aec9-835e5b724bb4" transform="1 0 0 0 1 0 0 0 1 ${offset.map((v) => v.toFixed(4)).join(" ")}" printable="1"/></build></model>`;
  const points = vertices
    .map(
      (v) =>
        `<vertex x="${(v[0] - (low[0] + high[0]) / 2).toFixed(5)}" y="${(v[1] - (low[1] + high[1]) / 2).toFixed(5)}" z="${(v[2] - (low[2] + high[2]) / 2).toFixed(5)}"/>`,
    )
    .join("\n");
  const triangles = faces
    .map(
      ([a, b, c], i) =>
        `<triangle v1="${a}" v2="${b}" v3="${c}" paint_color="${paintCode(labels[i]! + 1)}"/>`,
    )
    .join("\n");
  const object = `${xml}<model unit="millimeter" xml:lang="en-US" ${ns}><metadata name="BambuStudio:3mfVersion">1</metadata><resources><object id="1" p:UUID="00010000-81cb-4c03-9d28-80fed5dfa1dc" type="model"><mesh><vertices>${points}</vertices><triangles>${triangles}</triangles></mesh></object></resources><build/></model>`;
  const meta = `${xml}<config><object id="2"><metadata key="name" value="${escape(name)}"/><metadata key="extruder" value="1"/><metadata face_count="${faces.length}"/><part id="1" subtype="normal_part"><metadata key="name" value="${escape(name)}"/><metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/></part></object><plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value=""/><metadata key="locked" value="false"/><model_instance><metadata key="object_id" value="2"/><metadata key="instance_id" value="0"/><metadata key="identify_id" value="1"/></model_instance></plate></config>`;
  const files = {
    "[Content_Types].xml": `${xml}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`,
    "_rels/.rels": rels("/3D/3dmodel.model"),
    "3D/3dmodel.model": root,
    "3D/_rels/3dmodel.model.rels": rels("/3D/Objects/object_1.model"),
    "3D/Objects/object_1.model": object,
    "Metadata/model_settings.config": meta,
    "Metadata/project_settings.config": JSON.stringify(settings, null, 4),
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}
export function readProject(data: Uint8Array) {
  const files = unzipSync(data),
    mesh = strFromU8(files["3D/Objects/object_1.model"]!),
    root = strFromU8(files["3D/3dmodel.model"]!);
  const vertices = [...mesh.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)].map(
    (m) => [Number(m[1]), Number(m[2]), Number(m[3])] as Vec3,
  );
  const triangles = [
    ...mesh.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"(?: paint_color="([0-9A-F]*)")?/g),
  ];
  const faces = triangles.map((m) => [Number(m[1]), Number(m[2]), Number(m[3])] as Face),
    filaments = triangles.map((m) => paintFilament(m[4] ?? "") ?? 0);
  const transform = root.match(/<item [^>]*transform="([^"]+)"/),
    buildOffset = transform
      ? (transform[1]!.split(/\s+/).slice(9, 12).map(Number) as Vec3)
      : ([0, 0, 0] as Vec3);
  const settings = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(strFromU8(files["Metadata/project_settings.config"]!)));
  return { vertices, faces, filaments, settings, buildOffset };
}
