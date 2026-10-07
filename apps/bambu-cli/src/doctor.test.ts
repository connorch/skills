import { describe, expect, it } from "vite-plus/test";
import { Config } from "./config.ts";
import { diagnose, type Network, type Reach } from "./doctor.ts";
const config = new Config({
  dir: "/doctor-test-config-never-written",
  env: { BAMBU_IP: "10.0.0.5", BAMBU_SERIAL: "01P", BAMBU_MODEL: "P1S" },
  keychain: { read: () => undefined, write: () => {}, remove: () => {} },
});
function network(printer: Reach, router: Reach): Network {
  return {
    reach: async (host) => (host === "10.0.0.5" ? printer : router),
    gateway: () => "10.0.0.1",
  };
}
async function printerFinding(net: Network) {
  return (await diagnose(config, net)).findLast((f) => f.text.includes("10.0.0.5"))!;
}
describe("doctor printer reach", () => {
  it("passes when the MQTT port answers", async () => {
    expect(await printerFinding(network("open", "open"))).toMatchObject({ level: "ok" });
  });
  it("names the Local Network permission when only the printer is unroutable", async () => {
    const finding = await printerFinding(network("unreachable", "refused"));
    expect(finding.level).toBe("warn");
    expect(finding.text).toContain("Local Network");
    expect(finding.text).toContain("off");
    // A router that serves nothing on the probed port is still a router.
    expect((await printerFinding(network("unreachable", "silent"))).text).toContain(
      "Local Network",
    );
  });
  it("blames the network when the router is unreachable too", async () => {
    const finding = await printerFinding(network("unreachable", "unreachable"));
    expect(finding.level).toBe("warn");
    expect(finding.text).toContain("router");
  });
});
