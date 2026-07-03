'use strict';
// Renders the Oceano app icon (build/icon.png, 512×512) with zero external deps —
// a pure-Node PNG encoder. Same mark as the runtime tray icon (trayIcon.js):
// a bioluminescent-cyan disc with the "≈" wave, here on a navy rounded-square field
// so it reads as a proper launcher/dock icon. Re-run with `node build/make-icon.js`.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const SIZE = 512;
const NAVY = [0x06, 0x12, 0x1a]; // #06121a
const CYAN = [0x3a, 0xd6, 0xe3]; // #3ad6e3

const buf = Buffer.alloc(SIZE * SIZE * 4); // RGBA, zero = transparent
const px = (x, y, [r, g, b], a) => {
  const i = (y * SIZE + x) * 4;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
};

const c = (SIZE - 1) / 2;
const radius = SIZE * 0.22;            // rounded-square corner radius
const discR = SIZE * 0.34;             // cyan disc radius
// signed distance to a rounded-square edge (positive = inside)
const insideRoundedSquare = (x, y) => {
  const dx = Math.abs(x - c) - (SIZE / 2 - 1 - radius);
  const dy = Math.abs(y - c) - (SIZE / 2 - 1 - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return radius - outside; // >0 inside, ~0 on the rounded edge
};

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const sd = insideRoundedSquare(x, y);
    if (sd <= -1) continue;                                   // outside → transparent
    const bgA = sd < 1 ? Math.round(255 * (sd + 1) / 2) : 255; // 1px antialiased edge
    px(x, y, NAVY, bgA);
    const d = Math.hypot(x - c, y - c);
    if (d <= discR + 0.5) {
      const a = d > discR - 1 ? 160 : 255;                    // soft disc edge
      px(x, y, CYAN, a);
    }
  }
}

// two wavy "≈" strokes carved in navy across the disc
const amp = SIZE * 0.09, freq = (Math.PI * 2) / (SIZE * 0.62), thick = SIZE * 0.018;
for (const base of [SIZE * 0.44, SIZE * 0.58]) {
  for (let x = 0; x < SIZE; x++) {
    const wy = base + amp * Math.sin((x - c) * freq);
    for (let dy = -thick; dy <= thick; dy++) {
      const y = Math.round(wy + dy);
      if (y < 0 || y >= SIZE) continue;
      if (Math.hypot(x - c, y - c) <= discR - thick) px(x, y, NAVY, 255);
    }
  }
}

// ---- minimal PNG encoder (RGBA, no interlace) ----
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c2 = n;
    for (let k = 0; k < 8; k++) c2 = c2 & 1 ? 0xedb88320 ^ (c2 >>> 1) : c2 >>> 1;
    t[n] = c2 >>> 0;
  }
  return (b) => { let crc = 0xffffffff; for (const byte of b) crc = t[(crc ^ byte) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; };
})();
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const tb = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(Buffer.concat([tb, data])), 0);
  return Buffer.concat([len, tb, data, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  buf.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, 'icon.png');
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
