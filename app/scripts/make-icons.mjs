// Gera os ícones PNG do manifest sem dependências externas.
//
//   node scripts/make-icons.mjs
//
// Escreve icons/icon-192.png, icons/icon-512.png e icons/icon-maskable-512.png.
// O SVG (icons/icon.svg) é à mão e continua a ser a fonte visual; este script
// reproduz a mesma marca em raster para browsers que não aceitam SVG no manifest.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'icons');

const NAVY = [0x15, 0x38, 0x5b, 255];
const WHITE = [0xff, 0xff, 0xff, 255];
const CLEAR = [0, 0, 0, 0];

// Marca: haste vertical + três travessões, na mesma proporção do SVG.
// [x, y, largura, altura] em fracção do lado do ícone.
const E_BARS = [
  [0.301, 0.270, 0.090, 0.461],
  [0.301, 0.270, 0.420, 0.090],
  [0.301, 0.455, 0.359, 0.090],
  [0.301, 0.641, 0.420, 0.090],
];
const UNDERLINE = [0.301, 0.773, 0.420, 0.035];

// ── PNG ──────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(size, pixelAt) {
  const stride = 1 + size * 4;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filtro "None": o mais simples e o que os decoders aceitam todos
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelAt(x, y);
      const o = rowStart + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── desenho ──────────────────────────────────────────────────────────────────

function insideRoundedCorner(x, y, size, radius) {
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function inBar(fx, fy, [bx, by, bw, bh]) {
  return fx >= bx && fx < bx + bw && fy >= by && fy < by + bh;
}

/**
 * Pinta um ícone. `glyphScale` < 1 mete a marca dentro da zona segura
 * exigida pelo propósito "maskable" (80% centrais).
 */
function paintIcon(size, { radius, glyphScale }) {
  const bars = E_BARS.map(([x, y, w, h]) => {
    const cx = 0.5 + (x - 0.5) * glyphScale;
    const cy = 0.5 + (y - 0.5) * glyphScale;
    return [cx, cy, w * glyphScale, h * glyphScale];
  });
  const underline = (() => {
    const [x, y, w, h] = UNDERLINE;
    return [
      0.5 + (x - 0.5) * glyphScale,
      0.5 + (y - 0.5) * glyphScale,
      w * glyphScale,
      h * glyphScale,
    ];
  })();

  return (px, py) => {
    if (radius > 0 && !insideRoundedCorner(px + 0.5, py + 0.5, size, radius)) return CLEAR;
    const fx = (px + 0.5) / size;
    const fy = (py + 0.5) / size;
    if (bars.some((b) => inBar(fx, fy, b))) return WHITE;
    if (inBar(fx, fy, underline)) return [0x3d, 0x8f, 0xd1, 255];
    return NAVY;
  };
}

// ── main ─────────────────────────────────────────────────────────────────────

mkdirSync(OUT, { recursive: true });

const targets = [
  { file: 'icon-192.png', size: 192, radius: 192 * 0.19, glyphScale: 1 },
  { file: 'icon-512.png', size: 512, radius: 512 * 0.19, glyphScale: 1 },
  // Maskable: fundo até às bordas e marca dentro dos 80% centrais de segurança.
  { file: 'icon-maskable-512.png', size: 512, radius: 0, glyphScale: 0.72 },
];

for (const t of targets) {
  const buf = encodePng(t.size, paintIcon(t.size, { radius: t.radius, glyphScale: t.glyphScale }));
  writeFileSync(join(OUT, t.file), buf);
  console.log(`${t.file}  ${t.size}x${t.size}  ${buf.length} bytes`);
}
