# Review Pages are self-contained HTML files, one per Model

`bambu view` publishes a Review Page by inlining the Model (as GLB) and its
Printability Report into a single HTML file built from `apps/bambu-viewer`, then
uploading it with `wovn put`. We chose this over one shared viewer on Wovn that
loads a GLB by URL, because a Review Page is a record of what Connor approved and
must not change when the viewer does, because the agent screenshots the same local
file it publishes without logging in, and because it does not depend on Wovn
continuing to serve uploaded HTML unsandboxed (which its ADR 0003 says to revisit).
The cost is a few megabytes per page, which Wovn does not care about.
