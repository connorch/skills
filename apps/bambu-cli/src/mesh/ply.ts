import type { Mesh } from "./geometry.ts";
import { weld } from "./geometry.ts";
interface Property {
  name: string;
  type: string;
  countType?: string;
}
const widths: Record<string, number> = {
  char: 1,
  int8: 1,
  uchar: 1,
  uint8: 1,
  short: 2,
  int16: 2,
  ushort: 2,
  uint16: 2,
  int: 4,
  int32: 4,
  uint: 4,
  uint32: 4,
  float: 4,
  float32: 4,
  double: 8,
  float64: 8,
};
// PLY input falls back to STL for derived files, as in upstream's analyze tests.
export function loadPLY(bytes: Uint8Array): Mesh {
  const text = new TextDecoder().decode(bytes),
    end = /end_header\r?\n/.exec(text);
  if ((!text.startsWith("ply\n") && !text.startsWith("ply\r\n")) || !end)
    throw new Error("invalid PLY header");
  const header = text.slice(0, end.index),
    format = /format (\S+) /.exec(header)?.[1],
    elements: { name: string; count: number; properties: Property[] }[] = [];
  for (const line of header.split(/\r?\n/)) {
    const values = line.trim().split(/\s+/);
    if (values[0] === "element")
      elements.push({ name: values[1]!, count: Number(values[2]), properties: [] });
    if (values[0] === "property") {
      const property =
        values[1] === "list"
          ? { name: values[4]!, type: values[3]!, countType: values[2]! }
          : { name: values[2]!, type: values[1]! };
      elements.at(-1)?.properties.push(property);
    }
  }
  const ascii = format === "ascii",
    little = format === "binary_little_endian";
  if (!ascii && !little && format !== "binary_big_endian")
    throw new Error("unsupported PLY format");
  const headerSize = new TextEncoder().encode(text.slice(0, end.index + end[0].length)).length,
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    tokens = ascii
      ? text
          .slice(end.index + end[0].length)
          .trim()
          .split(/\s+/)
      : [];
  let offset = headerSize,
    cursor = 0;
  function scalar(type: string): number {
    const width = widths[type];
    if (!width) throw new Error(`unsupported PLY type ${type}`);
    if (ascii) return Number(tokens[cursor++]);
    let result: number;
    switch (type) {
      case "char":
      case "int8":
        result = view.getInt8(offset);
        break;
      case "uchar":
      case "uint8":
        result = view.getUint8(offset);
        break;
      case "short":
      case "int16":
        result = view.getInt16(offset, little);
        break;
      case "ushort":
      case "uint16":
        result = view.getUint16(offset, little);
        break;
      case "int":
      case "int32":
        result = view.getInt32(offset, little);
        break;
      case "uint":
      case "uint32":
        result = view.getUint32(offset, little);
        break;
      case "float":
      case "float32":
        result = view.getFloat32(offset, little);
        break;
      default:
        result = view.getFloat64(offset, little);
    }
    offset += width;
    return result;
  }
  const positions: number[] = [],
    indices: number[] = [];
  for (const element of elements) {
    // Each record takes at least one token or byte, so a count past what is
    // left in the file is wrong before any of it is read.
    const remaining = ascii ? tokens.length - cursor : bytes.length - offset;
    if (!Number.isSafeInteger(element.count) || element.count < 0)
      throw new Error("invalid PLY element count");
    if (element.count > remaining)
      throw new Error(`PLY declares ${element.count} ${element.name} records but holds fewer`);
    for (let i = 0; i < element.count; i++) {
      const record: Record<string, number> = {};
      let face: number[] = [];
      for (const p of element.properties) {
        if (p.countType) {
          const count = scalar(p.countType);
          if (!Number.isSafeInteger(count) || count < 0 || count > bytes.length)
            throw new Error("invalid PLY list count");
          const values = Array.from({ length: count }, () => scalar(p.type));
          if (p.name === "vertex_indices" || p.name === "vertex_index") face = values;
        } else record[p.name] = scalar(p.type);
      }
      if (element.name === "vertex") positions.push(record.x!, record.y!, record.z!);
      if (element.name === "face")
        for (let j = 1; j < face.length - 1; j++) indices.push(face[0]!, face[j]!, face[j + 1]!);
    }
  }
  if (
    !indices.length ||
    positions.some((p) => !Number.isFinite(p)) ||
    indices.some((i) => !Number.isInteger(i) || i < 0 || i * 3 >= positions.length)
  )
    throw new Error("invalid or empty PLY mesh");
  return weld({
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    source: { format: "ply" },
  });
}
