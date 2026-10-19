# Review Pages are self-contained HTML files, one per Model

`bambu view` publishes a Review Page by inlining the Model (as GLB) and its
Printability Report into a single HTML file built from `apps/bambu-viewer`, then
uploading it with `vaut put`. We chose this over one shared viewer on Vaut that
loads a GLB by URL, because a Review Page is a record of what Connor approved and
must not change when the viewer does, because the agent screenshots the same local
file it publishes without logging in, and because it does not depend on Vaut
continuing to serve uploaded HTML unsandboxed (which its ADR 0003 says to revisit).
The cost is a few megabytes per page, which Vaut does not care about.
