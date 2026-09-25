import path from "node:path"
import { cloudflare } from "@cloudflare/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// The files.wovn.org app: a TanStack Start app running inside the Cloudflare
// Worker (docs/adr/0004). Everything the app serves for itself - client
// assets, server-function RPC - lives under the reserved /_/ prefix so one
// Reserved Key covers it. The injected Banner bundle is a second build
// (vite.banner.config.ts) into the same client output directory.
export default defineConfig({
  plugins: [
    tailwindcss(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart({
      client: { base: "/_" },
      serverFns: { base: "/_/fn" },
    }),
    react(),
  ],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  build: { assetsDir: "_" },
})
