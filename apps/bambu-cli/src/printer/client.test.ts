import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vite-plus/test";
import { PrinterAuthError, PrinterConnectionError, readReport } from "./client.ts";
const printer = { host: "192.168.1.50", serial: "SERIAL", accessCode: "12345678" };
class Client extends EventEmitter {
  subscribeAsync = vi.fn(async (_topic: string) => {});
  publishAsync = vi.fn(async (_topic: string, _payload: string) => {});
  endAsync = vi.fn(async (_force: boolean) => {});
}
describe("MQTT transport", () => {
  it("subscribes before pushall, merges reports and closes on success", async () => {
    const client = new Client();
    const connect = vi.fn(() => client);
    const pending = readReport(printer, connect, 1000);
    client.emit("connect");
    await Promise.resolve();
    await Promise.resolve();
    expect(connect).toHaveBeenCalledWith(
      "mqtts://192.168.1.50:8883",
      expect.objectContaining({
        username: "bblp",
        password: "12345678",
        rejectUnauthorized: false,
        reconnectPeriod: 0,
      }),
    );
    expect(client.subscribeAsync).toHaveBeenCalledWith("device/SERIAL/report");
    expect(client.publishAsync).toHaveBeenCalledWith(
      "device/SERIAL/request",
      JSON.stringify({ pushing: { sequence_id: "0", command: "pushall" } }),
    );
    client.emit(
      "message",
      "wrong/topic",
      Buffer.from('{"print":{"gcode_state":"RUNNING","nozzle_temper":220,"ams":{}}}'),
    );
    client.emit("message", "device/SERIAL/report", Buffer.from('{"print":{"nozzle_temper":30}}'));
    client.emit(
      "message",
      "device/SERIAL/report",
      Buffer.from('{"print":{"gcode_state":"IDLE","ams":{}}}'),
    );
    expect(await pending).toEqual({ nozzle_temper: 30, gcode_state: "IDLE", ams: {} });
    expect(client.endAsync).toHaveBeenCalledWith(true);
  });
  it.each([
    ["Not authorized", PrinterAuthError],
    ["network gone", PrinterConnectionError],
  ])("closes on error %s", async (message, ErrorType) => {
    const client = new Client(),
      pending = readReport(printer, () => client);
    const result = expect(pending).rejects.toBeInstanceOf(ErrorType);
    client.emit("error", new Error(message));
    await result;
    expect(client.endAsync).toHaveBeenCalledWith(true);
  });
  it("clears the deadline after success and closes on timeout", async () => {
    vi.useFakeTimers();
    try {
      const client = new Client(),
        pending = readReport(printer, () => client, 15_000),
        result = expect(pending).rejects.toThrow("within 15 s");
      await vi.advanceTimersByTimeAsync(15_000);
      await result;
      expect(client.endAsync).toHaveBeenCalledWith(true);
      expect(vi.getTimerCount()).toBe(0);
      const successful = new Client(),
        done = readReport(printer, () => successful);
      successful.emit(
        "message",
        "device/SERIAL/report",
        Buffer.from('{"print":{"gcode_state":"IDLE","nozzle_temper":30,"ams":{}}}'),
      );
      await done;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
