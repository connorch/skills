import { describe, expect, it } from "vite-plus/test";
import { join } from "node:path";
import {
  bundleVersion,
  cliCandidates,
  discoveryFileSystem,
  findCli,
  findProfilesDir,
  profileCandidates,
} from "./discovery.ts";
function mockFs(bundles: [string, string][], executables: string[] = []) {
  const files = new Map(
    bundles.map(([root, version]) => [join(root, "BBL.json"), JSON.stringify({ version })]),
  );
  const directories = new Set(bundles.map(([root]) => join(root, "BBL")));
  return {
    ...discoveryFileSystem,
    read: (path: string) => {
      const text = files.get(path);
      if (!text) throw new Error("missing");
      return text;
    },
    isFile: (path: string) => files.has(path) || executables.includes(path),
    isDirectory: (path: string) => directories.has(path),
  };
}
describe("macOS discovery", () => {
  it("looks in app bundle first and user data folder", () => {
    expect(cliCandidates("/home")[0]).toEqual([
      "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio",
    ]);
    expect(profileCandidates("/home")[0]).toBe(
      "/Applications/BambuStudio.app/Contents/Resources/profiles",
    );
    expect(profileCandidates("/home")).toContain(
      "/home/Library/Application Support/BambuStudio/system",
    );
  });
  it("looks beside CLI first", () => {
    expect(profileCandidates("/home", ["/custom/Contents/MacOS/BambuStudio"])[0]).toBe(
      "/custom/Contents/Resources/profiles",
    );
  });
  it("newest wins, ties go beside CLI", () => {
    const beside = "/custom/Contents/Resources/profiles",
      user = "/home/Library/Application Support/BambuStudio/system";
    const cli = ["/custom/Contents/MacOS/BambuStudio"];
    expect(
      findProfilesDir(cli, {
        home: "/home",
        env: {},
        fs: mockFs([
          [beside, "02.07.00.08"],
          [user, "02.07.00.08"],
        ]),
      }),
    ).toBe(beside);
    expect(
      findProfilesDir(cli, {
        home: "/home",
        env: {},
        fs: mockFs([
          [beside, "02.07.00.08"],
          [user, "02.08.00.01"],
        ]),
      }),
    ).toBe(user);
  });
  it("rejects missing bundle", () => {
    expect(findProfilesDir(undefined, { home: "/home", env: {}, fs: mockFs([]) })).toBeUndefined();
  });
  it("environment overrides are authoritative", () => {
    const fs = mockFs([["/profiles", "02.07.00.08"]], ["/exe"]);
    const options = {
      home: "/home",
      env: { BAMBU_STUDIO_CLI: "/exe", BAMBU_STUDIO_PROFILES: "/profiles" },
      fs,
    };
    expect(findCli(options)).toEqual(["/exe"]);
    expect(findProfilesDir(undefined, options)).toBe("/profiles");
    expect(findCli({ ...options, env: { BAMBU_STUDIO_CLI: "/nope" } })).toBeUndefined();
    expect(
      findProfilesDir(undefined, { ...options, env: { BAMBU_STUDIO_PROFILES: "/nope" } }),
    ).toBeUndefined();
  });
  it("parses bundle version", () => {
    const fs = mockFs([["/a", "02.07.00.08"]]);
    expect(bundleVersion("/a", fs)).toEqual([2, 7, 0, 8]);
    expect(bundleVersion("/b", fs)).toEqual([]);
  });
});
