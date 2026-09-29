import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";

// One self-contained file: the `ship:machine` script copies
// dist/claude-router.mjs to ~/.local/bin/claude-router and the LaunchAgent
// runs it from there, so dependencies have to be inlined.
export default mergeConfig(
  baseConfig,
  defineConfig({
    pack: {
      entry: ["src/claude-router.ts"],
      outDir: "dist",
      clean: true,
      deps: { alwaysBundle: ["commander", "zod"], onlyBundle: false },
      banner: { js: "#!/usr/bin/env node\n" },
    },
  }),
);
