import type { MeshIO } from "./load.ts";
export function memoryIO() {
  const files = new Map<string, Uint8Array>();
  const io: MeshIO = {
    read(path) {
      const bytes = files.get(path);
      if (!bytes) throw new Error("missing");
      return bytes;
    },
    write(path, data) {
      files.set(path, data);
    },
  };
  return { files, io };
}
