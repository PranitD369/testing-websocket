// Generates the PWA icon PNGs as solid-color squares with a centered circle.
// Used in lieu of a real designer asset for the lab; replace these PNGs with
// your real icons before shipping to production.

import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '..', 'public');

const BG = [15, 23, 42]; // #0f172a
const FG = [56, 189, 248]; // #38bdf8
const ACCENT = [74, 222, 128]; // #4ade80

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const payload = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(payload) >>> 0, 0);
  return Buffer.concat([length, payload, crc]);
}

function makePng(size, maskable) {
  const rowLen = 1 + size * 3; // filter byte + RGB
  const raw = Buffer.alloc(rowLen * size);
  const cx = size / 2;
  const cy = size / 2;
  // Maskable icons need a "safe zone" — fill the outer ring with FG and inner with BG.
  const innerR = size * (maskable ? 0.32 : 0.42);
  const outerR = size * (maskable ? 0.45 : 0.46);
  for (let y = 0; y < size; y++) {
    const rowStart = y * rowLen;
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy);
      let col = BG;
      if (d < innerR) col = ACCENT;
      else if (d < outerR) col = FG;
      const i = rowStart + 1 + x * 3;
      raw[i] = col[0];
      raw[i + 1] = col[1];
      raw[i + 2] = col[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const idat = deflateSync(raw);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

writeFileSync(resolve(outDir, 'icon-192.png'), makePng(192, false));
writeFileSync(resolve(outDir, 'icon-512.png'), makePng(512, false));
writeFileSync(resolve(outDir, 'icon-512-maskable.png'), makePng(512, true));
console.log('generated icon-192.png, icon-512.png, icon-512-maskable.png');
