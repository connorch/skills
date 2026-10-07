import { createServer, type AddressInfo, type Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { inflateSync } from "node:zlib";
import { expect, it } from "vite-plus/test";
import { KEYSYMS, png, Rfb, vncResponse } from "./rfb.ts";

// What Tart's server sends: 32 bpp little-endian, red at shift 16, green 8,
// blue 0, a 4x2 screen that turns out to be 2x1 once a client asks.
function serverInit(width: number, height: number): Buffer {
  const init = Buffer.alloc(24);
  init.writeUInt16BE(width, 0);
  init.writeUInt16BE(height, 2);
  init.set([32, 24, 0, 1], 4);
  for (const at of [8, 10, 12]) init.writeUInt16BE(255, at);
  init.set([16, 8, 0], 14);
  init.writeUInt32BE(4, 20);
  return Buffer.concat([init, Buffer.from("fake")]);
}
function rect(
  x: number,
  y: number,
  w: number,
  h: number,
  encoding: number,
  body = Buffer.alloc(0),
) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(x, 0);
  head.writeUInt16BE(y, 2);
  head.writeUInt16BE(w, 4);
  head.writeUInt16BE(h, 6);
  head.writeInt32BE(encoding, 8);
  return Buffer.concat([head, body]);
}
function update(rects: Buffer[]): Buffer {
  const head = Buffer.from([0, 0, 0, 0]);
  head.writeUInt16BE(rects.length, 2);
  return Buffer.concat([head, ...rects]);
}
// An RFB 3.8 server with VNC authentication that answers the nth framebuffer
// request with frames[n] and records every client message after the handshake.
async function serve(password: string, frames: Buffer[]) {
  const messages: Buffer[] = [];
  const server = createServer(async (socket: Socket) => {
    let buffer = Buffer.alloc(0);
    const waiting: { n: number; resolve: (b: Buffer) => void }[] = [];
    const pump = () => {
      while (waiting.length && buffer.length >= waiting[0]!.n) {
        const { n, resolve } = waiting.shift()!;
        resolve(buffer.subarray(0, n));
        buffer = buffer.subarray(n);
      }
    };
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      pump();
    });
    const read = (n: number) =>
      new Promise<Buffer>((resolve) => {
        waiting.push({ n, resolve });
        pump();
      });
    socket.write("RFB 003.008\n");
    await read(12);
    socket.write(Buffer.from([1, 2]));
    await read(1);
    const challenge = Buffer.from("0123456789abcdef");
    socket.write(challenge);
    const ok = (await read(16)).equals(vncResponse(password, challenge));
    socket.write(Buffer.from([0, 0, 0, ok ? 0 : 1]));
    if (!ok) return socket.end();
    await read(1);
    socket.write(serverInit(4, 2));
    let requests = 0;
    for (;;) {
      const type = (await read(1))[0]!;
      const length = { 2: 3 + 4 * 4, 3: 9, 4: 7, 5: 5 }[type];
      if (length === undefined) return socket.destroy();
      messages.push(Buffer.concat([Buffer.from([type]), await read(length)]));
      if (type === 3) socket.write(frames[requests++] ?? Buffer.alloc(0));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: new URL(`vnc://:${encodeURIComponent(password)}@127.0.0.1:${port}`),
    messages,
    close: () => server.close(),
  };
}

it("authenticates with DES of the challenge under the bit-reversed password", () => {
  // DES of a zero block under a zero key; an empty password is a zero key.
  expect(vncResponse("", Buffer.alloc(8)).toString("hex")).toBe("8ca64de9c1b123a7");
});

it("advertises the pseudo-encodings Tart insists on, follows a resize, and decodes raw pixels", async () => {
  const red = Buffer.from([0, 0, 255, 0]),
    green = Buffer.from([0, 255, 0, 0]);
  const server = await serve("s3cret", [
    update([rect(0, 0, 2, 1, -223)]),
    update([
      rect(0, 0, 1, 1, -239, Buffer.alloc(5)),
      rect(0, 0, 2, 1, 0, Buffer.concat([red, green])),
    ]),
  ]);
  try {
    const rfb = await Rfb.open(server.url);
    expect([rfb.width, rfb.height]).toEqual([4, 2]);
    const shot = await rfb.screenshot();
    expect([rfb.width, rfb.height]).toEqual([2, 1]);
    const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]);
    expect(shot.equals(png(2, 1, rgba))).toBe(true);
    // The PNG's single IDAT inflates to one filter byte and the pixels.
    const idat = shot.readUInt32BE(33);
    expect(
      inflateSync(shot.subarray(41, 41 + idat)).equals(Buffer.concat([Buffer.from([0]), rgba])),
    ).toBe(true);
    rfb.key(KEYSYMS.enter!, true);
    rfb.move(1, 0, 1);
    for (let n = 0; server.messages.length < 5 && n < 100; n++) await sleep(10);
    const [encodings, first, second, key, move] = server.messages;
    expect([0, 1, 2, 3].map((i) => encodings!.readInt32BE(4 + i * 4))).toEqual([
      0, -223, -308, -239,
    ]);
    expect([first!.readUInt16BE(6), first!.readUInt16BE(8)]).toEqual([4, 2]);
    expect([second!.readUInt16BE(6), second!.readUInt16BE(8)]).toEqual([2, 1]);
    expect([key![1], key!.readUInt32BE(4)]).toEqual([1, KEYSYMS.enter]);
    expect([move![1], move!.readUInt16BE(2), move!.readUInt16BE(4)]).toEqual([1, 1, 0]);
    rfb.close();
  } finally {
    server.close();
  }
});

it("refuses a wrong password", async () => {
  const server = await serve("right", []);
  try {
    const url = new URL(server.url);
    url.password = "wrong";
    await expect(Rfb.open(url)).rejects.toThrow("wrong password");
  } finally {
    server.close();
  }
});
