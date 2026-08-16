// Secrets never appear in wrangler.jsonc, so `wrangler types` cannot include
// them in the generated Env; declared here via interface merging. Optional
// because the worker handles the unset case (503 until the secret is set).
interface Env {
  FILE_HOST_TOKEN?: string;
}
