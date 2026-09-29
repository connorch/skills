// The LaunchAgent that keeps the router running: RunAtLoad, KeepAlive,
// bound to loopback by the server itself. Written by `ship:machine`, never
// by `on` (D10).

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { SERVICE_LOG_PATH, STATE_DIR } from "./config.ts";

export const LABEL = "ai.connorch.claude-router";
export const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const DOMAIN = `gui/${userInfo().uid}`;

const escapeXml = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function plist(nodePath: string, binPath: string): string {
  const args = [nodePath, binPath, "serve"]
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>${escapeXml(homedir())}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(SERVICE_LOG_PATH)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(SERVICE_LOG_PATH)}</string>
</dict>
</plist>
`;
}

function launchctl(...args: string[]) {
  return spawnSync("launchctl", args, { encoding: "utf8" });
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// bootout returns before the old job is gone, and a bootstrap in that window
// fails with an I/O error. Wait for it, then bootstrap with a few retries.
export function installService(nodePath: string, binPath: string): void {
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(PLIST_PATH, plist(nodePath, binPath));
  launchctl("bootout", `${DOMAIN}/${LABEL}`);
  for (let i = 0; i < 20 && launchctl("print", `${DOMAIN}/${LABEL}`).status === 0; i++) pause(250);
  const boot = bootstrap();
  if (boot.status !== 0) throw new Error(`launchctl bootstrap failed: ${boot.stderr.trim()}`);
  launchctl("kickstart", "-k", `${DOMAIN}/${LABEL}`);
}

function bootstrap() {
  let boot = launchctl("bootstrap", DOMAIN, PLIST_PATH);
  for (let i = 0; i < 5 && boot.status !== 0; i++) {
    pause(500);
    boot = launchctl("bootstrap", DOMAIN, PLIST_PATH);
  }
  return boot;
}

// After `off`, for `on`. Same retry as install: a bootout may still be
// finishing.
export function startService(): boolean {
  return bootstrap().status === 0;
}

export function stopService(): void {
  launchctl("bootout", `${DOMAIN}/${LABEL}`);
}
