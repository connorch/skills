import mqtt from "mqtt";
import type { Printer } from "../config.ts";
import { mapping } from "./report.ts";

export class PrinterConnectionError extends Error {}
export class PrinterAuthError extends PrinterConnectionError {}
export type ReportReader = (printer: Printer) => Promise<Record<string, unknown>>;
export interface ReportClient {
  on(event: "connect" | "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "message", listener: (topic: string, payload: Buffer) => void): unknown;
  subscribeAsync(topic: string): Promise<unknown>;
  publishAsync(topic: string, payload: string): Promise<unknown>;
  endAsync(force: boolean): Promise<unknown>;
}
export type Connect = (url: string, options: mqtt.IClientOptions) => ReportClient;

// Merge incremental pushes, accepting only a snapshot with state, temperature and AMS.
export class ReportCollector {
  report: Record<string, unknown> = {};
  feed(payload: string): boolean {
    let doc: unknown;
    try {
      doc = JSON.parse(payload);
    } catch {
      return false;
    }
    Object.assign(this.report, mapping(mapping(doc).print));
    return Boolean(
      this.report.gcode_state && this.report.nozzle_temper !== undefined && this.report.ams,
    );
  }
}

// Read one full report; the injected connector lets tests exercise MQTT without a printer.
export async function readReport(
  printer: Printer,
  connect: Connect = mqtt.connect,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const client = connect(`mqtts://${printer.host}:8883`, {
    username: "bblp",
    password: printer.accessCode,
    rejectUnauthorized: false,
    reconnectPeriod: 0,
    connectTimeout: timeoutMs,
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const collector = new ReportCollector();
      timer = setTimeout(
        () =>
          reject(
            new PrinterConnectionError(
              `no report from ${printer.host} within ${Math.round(timeoutMs / 1000)} s (is the printer on and on this network, and are the IP and serial number right?)`,
            ),
          ),
        timeoutMs,
      );
      client.on("error", (error) =>
        reject(
          /authorized|authorization|password|credentials/i.test(error.message)
            ? new PrinterAuthError(error.message)
            : new PrinterConnectionError(error.message),
        ),
      );
      client.on("close", () =>
        reject(
          new PrinterConnectionError("printer closed the connection before a full report arrived"),
        ),
      );
      client.on("message", (topic, payload) => {
        if (topic === `device/${printer.serial}/report` && collector.feed(payload.toString()))
          resolve(collector.report);
      });
      client.on("connect", () => {
        void (async () => {
          await client.subscribeAsync(`device/${printer.serial}/report`);
          await client.publishAsync(
            `device/${printer.serial}/request`,
            JSON.stringify({ pushing: { sequence_id: "0", command: "pushall" } }),
          );
        })().catch((error) =>
          reject(
            new PrinterConnectionError(error instanceof Error ? error.message : String(error)),
          ),
        );
      });
    });
  } finally {
    // The losing timeout must not hold a successful command open for 15 seconds.
    clearTimeout(timer);
    await client.endAsync(true);
  }
}
