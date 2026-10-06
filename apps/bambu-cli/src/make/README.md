# Make

`bambu make <script.ts> [--out <file.stl>] [--json]` runs a trusted local TS or JS module and writes a binary STL. The default output is beside the script, with its extension replaced by `.stl`. Node 24 strips TypeScript types; use explicit extensions in imports. Scripts have ordinary Node access and are not sandboxed.

Export a synchronous or asynchronous default function accepting `Kit` and returning a Manifold from `kit.manifold`. For a script anywhere on disk in this checkout:

```ts
import type { Kit } from "~/Projects/skills/apps/bambu-cli/src/make/index.ts";

export default function model(kit: Kit) {
  return kit.bracket({ width: 30, height: 40, thickness: 3, holeDiameter: 3.2 });
}
```

Adjust the absolute type import to the checkout location. It is stripped at runtime, so it is not a dependency of the installed CLI. The examples use a relative type import.

All dimensions are millimetres. Helpers are `box(w, d, h, { center })`, `cylinder({ radius, height, radiusTop, segments, center })`, `sphere(radius, { segments })`, `extrude(polygon, height)`, `revolve(polygon, { segments })`, `bracket`, `plateWithHoles`, `enclosure`, `hull(models)`, and `compose(models)`. Optional options default to upstream values. Polygon points are `[x, y]` tuples; either winding works. Use `kit.manifold.Manifold` and `kit.manifold.CrossSection` for raw operations; transforms chain as `scale`, `rotate` (degrees), then `translate`. Boolean operations are `add`, `subtract`, and `intersect`.

`plateWithHoles` uses one central hole, two holes in a row, four on a square, or a bolt circle for other counts. `holeSpacing` is the distance between neighbouring centres. At least 1 mm remains at each plate edge. `enclosure({ ..., lid: true })` places its lid next to the body on the Plate, with a 0.2 mm gap per side around the plug-in rim.

The summary reports `output`, `dimensions`, `volume` (mm³), `surface_area` (mm²), `triangles`, `vertices`, `watertight`, and `bodies`. Multiple bodies trigger a human warning. Invalid and empty Models are refused before opening the output. Helpers share a fresh WASM instance for each Make. Raw Manifold/CrossSection objects should be deleted when no longer needed in long-running scripts.

`register(program, config)` is the integration entry point. `bundleManifoldWasm()` in `bundle.ts` must be added to `pack.plugins` alongside CLI registration. It embeds the npm package's WASM during `vp pack`, keeping the deployed CLI a single file. This hook is left for integration because this area permits only dependency additions in the shared Vite config. No Python, native addon, or network call is used by Make.

The two upstream test files use generated geometry and inline inputs, with no recorded fixtures to copy. Their numerical checks are ported into the adjacent tests. The examples exercise both synchronous and asynchronous exports and independently decode the STL's bounds and signed volume.
