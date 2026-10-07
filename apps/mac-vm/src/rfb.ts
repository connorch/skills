// A small RFB (VNC) client for Tart's `--vnc-experimental` server, which is
// Virtualization.framework's own: VNC authentication, raw encoding, and the
// cursor and desktop-size pseudo-encodings it insists a client accept. Input
// arrives in the guest as virtual HID events, so nothing inside the guest
// needs Accessibility or Screen Recording.

import { createCipheriv } from "node:crypto";
import { connect, type Socket } from "node:net";
import { crc32, deflateSync } from "node:zlib";

const RAW = 0,
  DESKTOP_SIZE = -223,
  CURSOR = -239,
  EXTENDED_DESKTOP_SIZE = -308;

// VNC authentication: DES of the challenge with the password's bytes bit-reversed.
// Node ships only triple DES, and two-key DES with both keys equal is single DES.
function vncResponse(password: string, challenge: Buffer): Buffer {
  const key = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) {
    const byte = i < password.length ? password.charCodeAt(i) : 0;
    let reversed = 0;
    for (let bit = 0; bit < 8; bit++) reversed = (reversed << 1) | ((byte >> bit) & 1);
    key[i] = reversed;
  }
  const cipher = createCipheriv("des-ede-ecb", Buffer.concat([key, key]), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(challenge), cipher.final()]);
}

// Filter-0 PNG of an RGBA buffer; enough for a screenshot without a dependency.
export function png(width: number, height: number, rgba: Buffer): Buffer {
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    rows[y * (width * 4 + 1)] = 0;
    rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]),
      head = Buffer.alloc(4),
      tail = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    tail.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

interface PixelFormat {
  bytes: number;
  bigEndian: boolean;
  max: [number, number, number];
  shift: [number, number, number];
}

export class Rfb {
  private buffer = Buffer.alloc(0);
  private readonly waiting: { bytes: number; resolve: (data: Buffer) => void }[] = [];
  private format!: PixelFormat;
  width = 0;
  height = 0;
  private frame = Buffer.alloc(0);
  private pointer = { x: 0, y: 0, buttons: 0 };

  private constructor(private readonly socket: Socket) {
    socket.on("data", (data) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      this.pump();
    });
  }

  // Handshake, authenticate, and learn the screen; rejects on any failure.
  static async open(url: URL, timeoutMs = 10_000): Promise<Rfb> {
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    const client = new Rfb(socket);
    const failed = new Promise<never>((_, reject) => {
      socket.on("error", (error) => reject(new Error(`VNC: ${error.message}`)));
      socket.on("close", () => reject(new Error("VNC: the server closed the connection")));
      setTimeout(() => reject(new Error("VNC: timed out")), timeoutMs).unref();
    });
    await Promise.race([client.handshake(decodeURIComponent(url.password)), failed]);
    return client;
  }

  private pump() {
    while (this.waiting.length && this.buffer.length >= this.waiting[0]!.bytes) {
      const { bytes, resolve } = this.waiting.shift()!;
      resolve(this.buffer.subarray(0, bytes));
      this.buffer = this.buffer.subarray(bytes);
    }
  }

  private read(bytes: number): Promise<Buffer> {
    return new Promise((resolve) => {
      this.waiting.push({ bytes, resolve });
      this.pump();
    });
  }

  private async handshake(password: string) {
    const version = (await this.read(12)).toString();
    if (!version.startsWith("RFB ")) throw new Error(`VNC: not an RFB server (${version.trim()})`);
    this.socket.write("RFB 003.008\n");
    const count = (await this.read(1))[0]!;
    if (!count) throw new Error("VNC: the server refused the connection");
    const types = [...(await this.read(count))];
    if (!types.includes(2)) throw new Error(`VNC: no VNC authentication offered (${types})`);
    this.socket.write(Buffer.from([2]));
    this.socket.write(vncResponse(password, await this.read(16)));
    if ((await this.read(4)).readUInt32BE(0) !== 0) throw new Error("VNC: wrong password");
    this.socket.write(Buffer.from([1])); // ClientInit, shared
    const init = await this.read(24);
    this.resize(init.readUInt16BE(0), init.readUInt16BE(2));
    this.format = {
      bytes: init[4]! / 8,
      bigEndian: init[6] !== 0,
      max: [init.readUInt16BE(8), init.readUInt16BE(10), init.readUInt16BE(12)],
      shift: [init[14]!, init[15]!, init[16]!],
    };
    await this.read(init.readUInt32BE(20)); // the desktop name
    const encodings = [RAW, DESKTOP_SIZE, EXTENDED_DESKTOP_SIZE, CURSOR],
      message = Buffer.alloc(4 + 4 * encodings.length);
    message[0] = 2;
    message.writeUInt16BE(encodings.length, 2);
    encodings.forEach((e, i) => message.writeInt32BE(e, 4 + i * 4));
    this.socket.write(message);
  }

  private resize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.frame = Buffer.alloc(width * height * 4);
  }

  // One full-screen update, returned as a PNG. The server may announce a new
  // desktop size first; the request is then repeated at that size.
  async screenshot(): Promise<Buffer> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const request = Buffer.alloc(10);
      request[0] = 3;
      request.writeUInt16BE(this.width, 6);
      request.writeUInt16BE(this.height, 8);
      this.socket.write(request);
      if (await this.update()) return png(this.width, this.height, this.frame);
    }
    throw new Error("VNC: the desktop size kept changing");
  }

  // Read one FramebufferUpdate into the frame; false if the screen was resized.
  // A bell or clipboard message the server sends on its own is skipped.
  private async update(): Promise<boolean> {
    let head = await this.read(4);
    while (head[0] !== 0) {
      if (head[0] === 2) head = Buffer.concat([head.subarray(1), await this.read(1)]);
      else if (head[0] === 3) {
        const length = Buffer.concat([head.subarray(1), await this.read(4)]).readUInt32BE(3);
        await this.read(length);
        head = await this.read(4);
      } else throw new Error(`VNC: unexpected server message ${head[0]}`);
    }
    let resized = false;
    for (let rect = head.readUInt16BE(2); rect > 0; rect--) {
      const r = await this.read(12),
        x = r.readUInt16BE(0),
        y = r.readUInt16BE(2),
        w = r.readUInt16BE(4),
        h = r.readUInt16BE(6),
        encoding = r.readInt32BE(8);
      if (encoding === RAW) this.paint(x, y, w, h, await this.read(w * h * this.format.bytes));
      else if (encoding === CURSOR)
        await this.read(w * h * this.format.bytes + Math.ceil(w / 8) * h);
      else if (encoding === DESKTOP_SIZE) {
        this.resize(w, h);
        resized = true;
      } else if (encoding === EXTENDED_DESKTOP_SIZE) {
        const screens = (await this.read(4))[0]!;
        await this.read(16 * screens);
        if (w !== this.width || h !== this.height) {
          this.resize(w, h);
          resized = true;
        }
      } else throw new Error(`VNC: unsupported encoding ${encoding}`);
    }
    return !resized;
  }

  private paint(x: number, y: number, w: number, h: number, data: Buffer) {
    const { bytes, bigEndian, max, shift } = this.format;
    for (let row = 0; row < h; row++)
      for (let col = 0; col < w; col++) {
        const at = (row * w + col) * bytes,
          pixel =
            bytes === 4
              ? bigEndian
                ? data.readUInt32BE(at)
                : data.readUInt32LE(at)
              : bigEndian
                ? data.readUInt16BE(at)
                : data.readUInt16LE(at),
          out = ((y + row) * this.width + (x + col)) * 4;
        for (let c = 0; c < 3; c++)
          this.frame[out + c] = Math.round((((pixel >>> shift[c]!) & max[c]!) * 255) / max[c]!);
        this.frame[out + 3] = 255;
      }
  }

  // Pointer position in framebuffer pixels; `buttons` is the RFB mask (1 left, 4 right).
  move(x: number, y: number, buttons = this.pointer.buttons) {
    this.pointer = { x, y, buttons };
    const message = Buffer.alloc(6);
    message[0] = 5;
    message[1] = buttons;
    message.writeUInt16BE(x, 2);
    message.writeUInt16BE(y, 4);
    this.socket.write(message);
  }

  key(keysym: number, down: boolean) {
    const message = Buffer.alloc(8);
    message[0] = 4;
    message[1] = down ? 1 : 0;
    message.writeUInt32BE(keysym, 4);
    this.socket.write(message);
  }

  // Called when the server drops the connection, which is how the VM's end is seen.
  onClose(callback: () => void) {
    this.socket.on("close", callback);
  }

  close() {
    this.socket.destroy();
  }
}

// X11 keysyms for the names `mac-vm key` accepts; letters and symbols are their
// own keysyms. Command is Meta, as Apple's VNC maps it.
export const KEYSYMS: Record<string, number> = {
  cmd: 0xffe7,
  command: 0xffe7,
  meta: 0xffe7,
  alt: 0xffe9,
  option: 0xffe9,
  ctrl: 0xffe3,
  control: 0xffe3,
  shift: 0xffe1,
  enter: 0xff0d,
  return: 0xff0d,
  tab: 0xff09,
  esc: 0xff1b,
  escape: 0xff1b,
  space: 0x20,
  backspace: 0xff08,
  delete: 0xffff,
  up: 0xff52,
  down: 0xff54,
  left: 0xff51,
  right: 0xff53,
  home: 0xff50,
  end: 0xff57,
  pageup: 0xff55,
  pagedown: 0xff56,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, 0xffbe + i])),
};

// The keysym for one typed character: ASCII as itself, Unicode through the
// 0x01000000 range, with newline and tab as their keys.
export function charKeysym(char: string): number {
  if (char === "\n") return KEYSYMS.enter!;
  if (char === "\t") return KEYSYMS.tab!;
  const code = char.codePointAt(0)!;
  return code >= 0x20 && code <= 0x7e ? code : 0x01000000 + code;
}

// Characters that need Shift on a US keyboard. Apple's VNC server turns
// keysyms into key codes without adding the modifier itself, so a capital
// letter sent alone arrives lowercase.
export function needsShift(char: string): boolean {
  return /[A-Z~!@#$%^&*()_+{}|:"<>?]/.test(char);
}
