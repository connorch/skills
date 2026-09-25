import { describe, expect, it } from "vite-plus/test";
import { outcomeOf } from "./fleet.ts";
import { formatReport, parseReport, type MachineReport } from "./report.ts";
import { parseTailnet } from "./tailnet.ts";

const report: MachineReport = {
  source: "origin/main 1a2b3c4",
  skills: 15,
  added: [],
  removed: [],
  packages: ["wovn-cli"],
  failures: [],
  dryRun: false,
};

describe("outcomeOf", () => {
  it("trusts the Machine's report over its exit code", () => {
    expect(outcomeOf(0, report, [])).toEqual({ kind: "ok", report });
    expect(outcomeOf(1, { ...report, failures: ["wovn-cli: exited 1\nmore"] }, [])).toEqual({
      kind: "failed",
      source: report.source,
      reason: "wovn-cli: exited 1",
    });
  });

  it("skips Machines that ssh cannot reach, and fails ones that broke before reporting", () => {
    // Tailscale SSH on macOS exits 0 even when the remote command failed.
    expect(outcomeOf(0, undefined, [])).toEqual({
      kind: "failed",
      source: "-",
      reason: "exited without a ship report",
    });
    const denied = 'tailscale: tailnet policy does not permit you to SSH as user "connorchevli"';
    expect(outcomeOf(255, undefined, [denied, "Connection closed by 100.64.0.1 port 22"])).toEqual({
      kind: "skipped",
      reason: `ssh: ${denied}`,
    });
    expect(
      outcomeOf(0, undefined, [
        "node:internal/modules/cjs/loader:1386",
        "Error: Cannot find module 'apps/ship/src/machine.ts'",
        "  requireStack: []",
        "Node.js v24.21.0",
      ]),
    ).toEqual({
      kind: "failed",
      source: "-",
      reason: "Error: Cannot find module 'apps/ship/src/machine.ts'",
    });
  });
});

describe("parseReport", () => {
  it("reads a full report and ignores one cut off mid-line", () => {
    const line = formatReport(report);
    expect(parseReport(line)).toEqual(report);
    expect(parseReport(line.slice(0, 20))).toBeUndefined();
  });
});

describe("parseTailnet", () => {
  const node = (DNSName: string, OS: string, extra: object = {}) => ({ DNSName, OS, ...extra });

  it("keeps macOS and linux Machines, named by their MagicDNS label", () => {
    const tailnet = parseTailnet({
      Self: node("connors-macbook-pro.tail.ts.net.", "macOS"),
      Peer: {
        a: node("connors-mac-studio.tail.ts.net.", "macOS", { Online: true, sshHostKeys: ["k"] }),
        b: node("bluefin.tail.ts.net.", "linux", { Online: false, sshHostKeys: null }),
        c: node("iphone184.tail.ts.net.", "iOS", { Online: true }),
      },
    });
    expect(tailnet.self).toEqual({
      name: "connors-macbook-pro",
      platform: "darwin",
      online: true,
      ssh: false,
    });
    expect(tailnet.fleet.map(({ name, online, ssh }) => ({ name, online, ssh }))).toEqual([
      { name: "bluefin", online: false, ssh: false },
      { name: "connors-mac-studio", online: true, ssh: true },
      { name: "connors-macbook-pro", online: true, ssh: false },
    ]);
  });
});
