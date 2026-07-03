'use strict';
// Generates the tray icon at runtime as a nativeImage — no asset file, no external dep.
// A bioluminescent-cyan disc with the Oceano "≈" wave. Electron's createFromBitmap wants BGRA.
const { nativeImage } = require('electron');

function makeTrayIcon(size = 32) {
  const buf = Buffer.alloc(size * size * 4); // BGRA, zero = transparent
  const c = (size - 1) / 2;                   // center
  const r = size / 2 - 1;                     // disc radius
  const CY = [0xe3, 0xd6, 0x3a];              // cyan #3ad6e3 as B,G,R
  const NV = [0x1a, 0x12, 0x06];              // navy #06121a as B,G,R

  const set = (x, y, bgr, a) => {
    const i = (y * size + x) * 4;
    buf[i] = bgr[0]; buf[i + 1] = bgr[1]; buf[i + 2] = bgr[2]; buf[i + 3] = a;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      if (d > r + 0.5) continue;                       // outside disc → transparent
      const a = d > r - 0.5 ? 150 : 255;               // soft 1px edge
      set(x, y, CY, a);
    }
  }
  // two wavy "≈" strokes across the disc
  const amp = size * 0.09, freq = (Math.PI * 2) / (size * 0.62);
  for (const base of [size * 0.40, size * 0.60]) {
    for (let x = 0; x < size; x++) {
      const wy = Math.round(base + amp * Math.sin((x - c) * freq));
      for (let dy = -1; dy <= 1; dy++) {
        const y = wy + dy;
        if (y < 0 || y >= size) continue;
        if (Math.hypot(x - c, y - c) <= r - 1.5) set(x, y, NV, 255);
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

module.exports = { makeTrayIcon };
