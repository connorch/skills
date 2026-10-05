import type { Command } from "commander";
import type { Config } from "../config.ts";
export * from "./geometry.ts";
export * from "./load.ts";
export * from "./ply.ts";
export * from "./topology.ts";
export * from "./rays.ts";
export * from "./hardware.ts";
export * from "./units.ts";
export * from "./repair.ts";
export * from "./orient.ts";
export * from "./checks.ts";
export * from "./report.ts";
// Mesh is a shared library; analyze registers its user-facing command separately.
export function register(_program: Command, _config: Config): void {}
