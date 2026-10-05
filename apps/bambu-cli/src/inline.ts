// A vp pack plugin that swaps one source module for generated code, so the
// packed single-file CLI carries an asset inline (the viewer template, the
// manifold WASM). In source runs the module's own code reads the asset from disk.
export function inline(moduleSuffix: string, code: () => string) {
  return {
    name: `inline:${moduleSuffix}`,
    load(id: string) {
      if (!id.replaceAll("\\", "/").endsWith(moduleSuffix)) return;
      return code();
    },
  };
}
