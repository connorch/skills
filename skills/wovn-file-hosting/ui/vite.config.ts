import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// The SPA is served by the wovn-files worker for Directory Routes; its asset
// bundle lives under the reserved /_/ prefix (see ../worker), so the app is
// built with that base and the output lands in dist/_ - the worker's ASSETS
// binding points at dist/.
export default defineConfig({
  base: "/_/",
  build: { outDir: "dist/_" },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
