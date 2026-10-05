`filaments.json`, `project_settings.json`, and `per_filament_keys.json` are copied
from the vendored upstream assets and colour template. `profiles.json` contains
flattened machine, default process and default PLA filament settings from upstream's
recorded slicing profiles, with inheritance and G-code includes resolved. Paint
selects a recorded 0.4 mm profile, defaulting to P1S, without requiring Studio.

The colour tests generate their GLBs with `fixtures/builder.ts`, ported from upstream's
`tests/glb_builder.py`. Upstream's colour tests do not consume recorded GLB fixtures.
`fixtures/p1s.json` is a verbatim recorded profile used to check the P1S default.
