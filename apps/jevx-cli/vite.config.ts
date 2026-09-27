import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";

// One self-contained file: the `ship:machine` script copies dist/jevx.mjs to
// ~/.local/bin/jevx, so dependencies have to be inlined rather than resolved
// from node_modules at run time.
export default mergeConfig(
  baseConfig,
  defineConfig({
    pack: {
      entry: ["src/jevx.ts"],
      outDir: "dist",
      clean: true,
      deps: { alwaysBundle: ["commander", "@typesafe-ai/sdk"], onlyBundle: false },
      banner: { js: "#!/usr/bin/env node\n" },
    },
  }),
);
