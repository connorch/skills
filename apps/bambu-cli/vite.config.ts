import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";
import { bundleManifoldWasm } from "./src/make/bundle.ts";
import { bundleViewerTemplate } from "./src/view/bundle.ts";

// One self-contained file: the `ship:machine` script copies dist/bambu.mjs to
// ~/.local/bin/bambu, so dependencies have to be inlined rather than resolved
// from node_modules at run time.
export default mergeConfig(
  baseConfig,
  defineConfig({
    pack: {
      entry: ["src/bambu.ts"],
      outDir: "dist",
      clean: true,
      deps: {
        alwaysBundle: [
          "commander",
          "mqtt",
          "basic-ftp",
          "zod",
          "@gltf-transform/core",
          "@gltf-transform/functions",
          "@gltf-transform/extensions",
          "meshoptimizer",
          "manifold-3d",
          "fflate",
          "pngjs",
          "jpeg-js",
        ],
        onlyBundle: false,
      },
      banner: { js: "#!/usr/bin/env node\n" },
      plugins: [bundleManifoldWasm(), bundleViewerTemplate()],
    },
  }),
);
