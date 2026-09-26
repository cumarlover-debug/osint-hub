// Draws the logo mark (dark disc, cyan ring, glowing cyan dot, as on the site) as PNG icons for the browser extension.
// No image libraries: pixels are computed with anti-aliasing and encoded with node:zlib.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const DISC = [0x0a, 0x24, 0x2e];
const CYAN = [0x45, 0xd7, 0xef];

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function icon(size) {
  const c = size / 2;
  const outer = size * 0.47;
  const ring = Math.max(1, size * 0.07);
  const dot = size * 0.17;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4); // filter byte 0, then RGBA
    for (let x = 0; x < size; x++) {
      // 4x4 supersampling for smooth edges: average premultiplied colour over the samples.
      let [r, g, b, a] = [0, 0, 0, 0];
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          const d = Math.hypot(x + (sx + 0.5) / 4 - c, y + (sy + 0.5) / 4 - c);
          if (d > outer) continue;
          // Cyan where the ring or dot is, otherwise the disc with a glow fading out from the dot.
          const glow = d <= dot || d >= outer - ring ? 1 : Math.max(0, 0.45 * (1 - (d - dot) / (outer * 0.55)));
          const col = DISC.map((v, i) => v + (CYAN[i] - v) * glow);
          r += col[0];
          g += col[1];
          b += col[2];
          a += 1;
        }
      const o = 1 + x * 4;
      if (a) {
        row[o] = Math.round(r / a);
        row[o + 1] = Math.round(g / a);
        row[o + 2] = Math.round(b / a);
      }
      row[o + 3] = Math.round((a / 16) * 255);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) writeFileSync(new URL(`../extension/icons/${size}.png`, import.meta.url), icon(size));
console.log('wrote extension/icons/{16,32,48,128}.png');
