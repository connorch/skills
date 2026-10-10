import { describe, expect, it } from "vite-plus/test";
import { contextFromEnv, contextFromTailscale } from "./context.ts";

describe("contextFromEnv", () => {
  it("reads the Machine fleetfizz passes to an Install Command", () => {
    expect(
      contextFromEnv({
        FLEETFIZZ_MACHINE: "connors-macbook-pro",
        FLEETFIZZ_PLATFORM: "darwin",
        FLEETFIZZ_MACHINES: "bluefin,connors-mac-studio,connors-macbook-pro",
      }),
    ).toEqual({
      machine: { name: "connors-macbook-pro", platform: "darwin" },
      knownMachines: ["bluefin", "connors-mac-studio", "connors-macbook-pro"],
    });
  });

  it("is undefined when run by hand, and rejects a partial or invalid context", () => {
    expect(contextFromEnv({ HOME: "/home/x" })).toBeUndefined();
    expect(() => contextFromEnv({ FLEETFIZZ_MACHINE: "connors-macbook-pro" })).toThrow();
    expect(() =>
      contextFromEnv({
        FLEETFIZZ_MACHINE: "x",
        FLEETFIZZ_PLATFORM: "windows",
        FLEETFIZZ_MACHINES: "x",
      }),
    ).toThrow();
  });
});

describe("contextFromTailscale", () => {
  it("names Machines by their first MagicDNS label and skips other OSes", () => {
    const node = (DNSName: string, OS: string) => ({ DNSName, OS });
    expect(
      contextFromTailscale({
        Self: node("connors-mac-studio.tail1234.ts.net.", "macOS"),
        Peer: {
          a: node("connors-macbook-pro.tail1234.ts.net.", "macOS"),
          b: node("bluefin.tail1234.ts.net.", "linux"),
          c: node("iphone184.tail1234.ts.net.", "iOS"),
        },
      }),
    ).toEqual({
      machine: { name: "connors-mac-studio", platform: "darwin" },
      knownMachines: ["bluefin", "connors-mac-studio", "connors-macbook-pro"],
    });
  });
});
