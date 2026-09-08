// Secrets never appear in wrangler.jsonc, so `wrangler types` cannot include
// them in the generated Env; declared here via interface merging. Optional
// because the host handles the unset case (requests fail unauthorized until
// the secret is set).
declare namespace Cloudflare {
  interface Env {
    WOVN_TOKEN?: string
  }
}
