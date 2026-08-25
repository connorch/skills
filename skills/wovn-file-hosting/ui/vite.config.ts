import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// The app is served by the worker at files.wovn.org/_/ from its static
// assets binding, so both the URL base and the output directory carry the
// /_ prefix (wrangler's assets directory points at dist/).
export default defineConfig({
  base: "/_/",
  build: {
    outDir: "dist/_",
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
