import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Config } from "../config.ts";
import fixture from "./fixtures/p1s_printing.json" with { type: "json" };
import { PrinterAuthError, PrinterConnectionError, readReport } from "./client.ts";
import { defaultWatchDependencies } from "./monitor.ts";
import { freshState } from "./events.ts";
import { fetchStatus, printerInfo, register } from "./index.ts";
vi.mock("./client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client.ts")>();
  return { ...actual, readReport: vi.fn() };
});
vi.mock("./monitor.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./monitor.ts")>();
  return { ...actual, defaultWatchDependencies: vi.fn(actual.defaultWatchDependencies) };
});
const dirs: string[] = [];
function config(configured = true) {
  const dir = mkdtempSync(join(tmpdir(), "bambu-cli-printer-"));
  dirs.push(dir);
  return new Config({
    dir,
    env: configured
      ? {
          BAMBU_IP: "192.168.1.50",
          BAMBU_SERIAL: "01P00A000000000",
          BAMBU_ACCESS_CODE: "12345678",
          BAMBU_MODEL: "P1S",
        }
      : {},
    keychain: { read: () => undefined, write: () => {}, remove: () => {} },
  });
}
async function command(args: string[], configured = true) {
  const lines: string[] = [],
    errors: string[] = [];
  vi.spyOn(console, "log").mockImplementation((value) => {
    lines.push(String(value));
  });
  vi.spyOn(console, "error").mockImplementation((value) => {
    errors.push(String(value));
  });
  const program = new Command();
  register(program, config(configured));
  await program.parseAsync(args, { from: "user" });
  return { lines, errors };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(readReport).mockReset();
  process.exitCode = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("upstream printer commands", () => {
  it("status JSON is one document", async () => {
    vi.mocked(readReport).mockResolvedValue(fixture.print);
    const out = await command(["status", "--json"]);
    expect(out.lines).toHaveLength(1);
    expect(JSON.parse(out.lines[0]!)).toMatchObject({
      schema: 1,
      model: "P1S",
      state: "RUNNING",
      layer: 57,
      trays: [{ active: false }, { active: true }, { active: false }],
    });
  });
  it("status human output and AMS JSON", async () => {
    vi.mocked(readReport).mockResolvedValue(fixture.print);
    const human = await command(["status"]);
    expect(human.lines[0]).toContain("RUNNING · 42% · layer 57/136 · 1 h 11 min left");
    const ams = await command(["ams", "--json"]);
    expect(JSON.parse(ams.lines[0]!).trays.map((s: { color: string }) => s.color)).toEqual([
      "#FFFFFF",
      "#FF6A13",
      "#000000",
    ]);
  });
  it("missing configuration is exit 2 with JSON error", async () => {
    const out = await command(["status", "--json"], false);
    expect(process.exitCode).toBe(2);
    expect(JSON.parse(out.lines[0]!).error.type).toBe("not_configured");
    expect(readReport).not.toHaveBeenCalled();
  });
  it.each([
    [new PrinterAuthError("Not authorized"), "auth"],
    [new PrinterConnectionError("no report"), "unreachable"],
  ])("connection failures return JSON and exit 1", async (error, kind) => {
    vi.mocked(readReport).mockRejectedValue(error);
    const out = await command(["status", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(out.lines[0]!).error.type).toBe(kind);
  });
  it("info never connects or exposes the access code", async () => {
    const out = await command(["info", "--json"]);
    expect(JSON.parse(out.lines[0]!)).toMatchObject({ configured: true, serial: "01P0…000" });
    expect(out.lines[0]).not.toContain("12345678");
    expect(readReport).not.toHaveBeenCalled();
    expect(printerInfo(config(false)).missing).toEqual(["printer_ip", "serial", "access_code"]);
  });
  it("read operation accepts injected transport", async () => {
    const read = vi.fn(async () => fixture.print);
    expect((await fetchStatus(config(), read)).state).toBe("RUNNING");
    expect(read).toHaveBeenCalledWith({
      host: "192.168.1.50",
      serial: "01P00A000000000",
      accessCode: "12345678",
    });
  });
  it("watch once emits one JSON document and no notification text", async () => {
    vi.mocked(defaultWatchDependencies).mockImplementation((_dir, _out, announce) => ({
      read: async () => fixture.print,
      store: { load: () => freshState(), save: () => {}, append: () => {} },
      now: () => 0,
      sleep: async () => {},
      announce,
      diagnostic: () => {},
    }));
    const out = await command(["watch", "--once", "--json"]);
    expect(out.lines).toHaveLength(1);
    expect(JSON.parse(out.lines[0]!).events.map((e: { kind: string }) => e.kind)).toEqual([
      "started",
      "alert",
    ]);
  });
  it("rejects removed auto-pause and invalid intervals before connecting", async () => {
    const out = await command(["watch", "--auto-pause", "--json"], false);
    expect(process.exitCode).toBe(2);
    expect(JSON.parse(out.lines[0]!).error.message).toContain("was removed in v2.1");
    expect(readReport).not.toHaveBeenCalled();
    const invalid = await command(["watch", "--interval", "9", "--json"]);
    expect(JSON.parse(invalid.lines[0]!).error.message).toContain("at least 10");
  });
});
