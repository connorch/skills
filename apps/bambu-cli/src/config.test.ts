import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { Config, ConfigError, type Keychain, mask } from "./config.ts";

// An in-memory Keychain keyed "service/account", so tests never touch macOS.
function fakeKeychain(
  items: Record<string, string> = {},
): Keychain & { items: Record<string, string> } {
  return {
    items,
    read: (account, service = "bambu") => items[`${service}/${account}`],
    write: (account, value) => {
      items[`bambu/${account}`] = value;
    },
    remove: (account) => {
      delete items[`bambu/${account}`];
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bambu-config-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("settings", () => {
  it("round-trips set and unset through config.json", () => {
    const config = new Config({ dir, env: {}, keychain: fakeKeychain() });
    config.set({ printer_ip: "10.0.0.5", serial: "01P00A", "3d_provider": "meshy" });
    expect(JSON.parse(readFileSync(config.file, "utf8"))).toEqual({
      printer_ip: "10.0.0.5",
      serial: "01P00A",
      "3d_provider": "meshy",
    });
    config.unset(["3d_provider"]);
    expect(config.settings()).toEqual({ printer_ip: "10.0.0.5", serial: "01P00A" });
  });

  it("rejects values outside the schema", () => {
    const config = new Config({ dir, env: {}, keychain: fakeKeychain() });
    expect(() => config.set({ "3d_provider": "openai" })).toThrow(/3d_provider/);
    expect(() => config.set({ printer_i: "10.0.0.5" })).toThrow(/unknown setting printer_i/);
    expect(() => config.unset(["printer_i"])).toThrow(/unknown setting printer_i/);
    writeFileSync(config.file, '{"preferred_format": "step"}');
    expect(() => config.settings()).toThrow(ConfigError);
  });

  it("lets environment variables override the file", () => {
    const config = new Config({
      dir,
      env: { BAMBU_IP: "192.168.1.9", BAMBU_3D_PROVIDER: "tripo" },
      keychain: fakeKeychain(),
    });
    config.set({ printer_ip: "10.0.0.5", "3d_provider": "meshy" });
    expect(config.settings()).toEqual({ printer_ip: "192.168.1.9", "3d_provider": "tripo" });
    // The file itself is untouched by the override.
    expect(config.stored()).toEqual({ printer_ip: "10.0.0.5", "3d_provider": "meshy" });
  });
  it("expands ~ in output_dir, from the file or the environment", () => {
    const config = new Config({ dir, env: {}, keychain: fakeKeychain() });
    config.set({ output_dir: "~/prints" });
    expect(config.settings().output_dir).toBe(join(homedir(), "prints"));
    expect(config.stored().output_dir).toBe("~/prints");
    const env = new Config({ dir, env: { BAMBU_OUTPUT_DIR: "~" }, keychain: fakeKeychain() });
    expect(env.settings().output_dir).toBe(homedir());
  });
});

describe("secrets", () => {
  it("reads the Keychain, with the environment taking precedence", () => {
    const keychain = fakeKeychain({ "bambu/access_code": "12345678" });
    expect(new Config({ dir, env: {}, keychain }).secret("access_code")).toBe("12345678");
    expect(
      new Config({ dir, env: { BAMBU_ACCESS_CODE: "87654321" }, keychain }).secret("access_code"),
    ).toBe("87654321");
  });

  it("falls back from 3d_api_key to the provider's key", () => {
    const keychain = fakeKeychain({ "bambu/tripo_api_key": "tsk_1" });
    const config = new Config({ dir, env: {}, keychain });
    expect(config.secret("3d_api_key")).toBeUndefined();
    expect(config.secret("3d_api_key", "tripo")).toBe("tsk_1");
    config.set({ "3d_provider": "tripo" });
    expect(config.secret("3d_api_key")).toBe("tsk_1");
    config.setSecret("3d_api_key", "generic");
    expect(config.secret("3d_api_key")).toBe("generic");
  });
});

describe("printer()", () => {
  it("names every missing piece in one error", () => {
    const config = new Config({ dir, env: {}, keychain: fakeKeychain() });
    config.set({ serial: "01P00A" });
    expect(() => config.printer()).toThrow(/printer_ip, the access_code secret missing/);
  });

  it("migrates the pre-port printer.json and its Keychain entry", () => {
    const keychain = fakeKeychain({ "openclaw-bambu-p1s/bblp": "11223344" });
    const config = new Config({ dir, env: {}, keychain });
    writeFileSync(
      config.legacyFile,
      JSON.stringify({
        host: "10.128.1.128",
        serial: "01P00C",
        keychainService: "openclaw-bambu-p1s",
      }),
    );
    expect(config.migrate()).toEqual({
      settings: { printer_ip: "10.128.1.128", serial: "01P00C" },
      accessCode: true,
    });
    expect(config.printer()).toEqual({
      host: "10.128.1.128",
      serial: "01P00C",
      accessCode: "11223344",
    });
    expect(keychain.items["bambu/access_code"]).toBe("11223344");
    expect(config.migrate()).toBeUndefined();
  });

  it("keeps printer.json when the old access code cannot be read", () => {
    const config = new Config({ dir, env: {}, keychain: fakeKeychain({}) });
    writeFileSync(
      config.legacyFile,
      JSON.stringify({ host: "10.128.1.128", serial: "01P00C", keychainService: "old" }),
    );
    expect(config.migrate()?.accessCode).toBe(false);
    expect(existsSync(config.legacyFile)).toBe(true);
  });
});

describe("mask", () => {
  it("keeps secrets recognisable but unusable", () => {
    expect(mask(undefined)).toBe("(not set)");
    expect(mask("123456")).toBe("******");
    expect(mask("msy_abcdefgh")).toBe("msy…gh");
  });
});
