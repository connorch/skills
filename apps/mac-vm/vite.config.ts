import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";

// One self-contained file: the `ship:machine` script copies dist/mac-vm.mjs to
// ~/.local/bin/mac-vm, so commander has to be inlined rather than resolved
// from node_modules at run time.
export default mergeConfig(
  baseConfig,
  defineConfig({
    pack: {
      entry: ["src/mac-vm.ts"],
      outDir: "dist",
      clean: true,
      deps: { alwaysBundle: ["commander"], onlyBundle: false },
      banner: { js: "#!/usr/bin/env node\n" },
    },
  }),
);
