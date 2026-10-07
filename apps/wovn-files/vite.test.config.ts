import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

// Tests for the pure modules under src/lib run in plain Node. The app's
// vite.config.ts carries the Cloudflare plugin, which would run them inside
// workerd instead; `pnpm test` points at this config.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["src/lib/**/*.test.ts"] },
});
