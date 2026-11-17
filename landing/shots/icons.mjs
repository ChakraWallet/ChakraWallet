// App icon for the landing page (logo + favicons) and for TON Connect's wallets list, rendered by the app's own icon
// renderer (scripts/icon.mjs).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { renderIcon } from '../../scripts/icon.mjs';

const OUT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../public');
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** Opaque PNG (RGB, no alpha channel), small: the best PNG filter for each row, then zlib at its strongest. */
function pngOpaque(size, rgba) {
  const bpp = 3, stride = size * bpp;
  const rows = Array.from({ length: size }, (_, y) => {
    const r = Buffer.alloc(stride);
    for (let x = 0; x < size; x++) { const i = (y * size + x) * 4; r[x * 3] = rgba[i]; r[x * 3 + 1] = rgba[i + 1]; r[x * 3 + 2] = rgba[i + 2]; }
    return r;
  });
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    const cur = rows[y], up = y ? rows[y - 1] : Buffer.alloc(stride);
    let best = null, bestType = 0, bestScore = Infinity;
    for (let type = 0; type <= 4; type++) { // none, sub, up, average, paeth: keep the one with the smallest residuals
      const out = Buffer.alloc(stride);
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0, b = up[i], c = i >= bpp ? up[i - bpp] : 0;
        const pred = type === 0 ? 0 : type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : paeth(a, b, c);
        out[i] = (cur[i] - pred) & 0xff;
        score += out[i] < 128 ? out[i] : 256 - out[i];
      }
      if (score < bestScore) { bestScore = score; best = out; bestType = type; }
    }
    raw[y * (stride + 1)] = bestType;
    best.copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
for (const [name, size] of [['icon.png', 512], ['favicon-32.png', 32], ['apple-touch-icon.png', 180]]) {
  fs.writeFileSync(path.join(OUT, name), png(size, Buffer.from(renderIcon(size, size, { mask: name === 'apple-touch-icon.png' ? 'none' : 'rounded' }))));
}
// TON Connect's wallets list (ton-connect/wallets-list): 288x288 PNG, solid background, square corners
fs.writeFileSync(path.join(OUT, 'tonconnect-icon.png'), pngOpaque(288, Buffer.from(renderIcon(288, 288, { mask: 'none' }))));
console.log('icons written to public/');
