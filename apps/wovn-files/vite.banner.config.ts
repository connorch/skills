import path from "node:path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// The Banner bundle injected into HTML Files (docs/adr/0003). Start allows a
// single client entry, so this is a separate build with fixed output names
// that the injector can reference without a manifest lookup. It carries no
// CSS: the stylesheet is inlined into the declarative shadow root by the
// server. Runs after the Start build, into the same client directory.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "dist/client",
    emptyOutDir: false,
    rollupOptions: {
      input: path.resolve(import.meta.dirname, "src/banner.tsx"),
      output: {
        entryFileNames: "_/banner.js",
        chunkFileNames: "_/banner-[hash].js",
        assetFileNames: "_/banner-[name][extname]",
      },
    },
  },
})
