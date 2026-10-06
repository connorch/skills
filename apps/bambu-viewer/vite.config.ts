import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// The Review Page template: one self-contained HTML file (docs/adr/0002 in
// apps/bambu-cli). `bambu view` fills its model and report placeholders and
// publishes the result, so the build must inline every script and style.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", copyPublicDir: false },
});
