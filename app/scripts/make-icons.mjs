// Gera os ícones PNG (web e Android) sem dependências externas.
//
//   node scripts/make-icons.mjs                      → app/icons/*.png (manifest/PWA)
//   node scripts/make-icons.mjs --android <res-dir>  → também os mipmap da APK
//
// O SVG (icons/icon.svg) é à mão e continua a ser a fonte visual; este script
// reproduz a mesma marca em raster para browsers e launchers que não aceitam SVG.
// Marca: fundo de vidro turquesa (gradiente + brilho + aro), E branco de cantos
// suaves e sublinhado turquesa — legível a 48 px.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'icons');

// ── paleta (tema verde turquesa glass) ──────────────────────────────────────
const G0 = [0x0e, 0x8a, 0x7d, 255]; // topo-esquerda do gradiente
const G1 = [0x04, 0x21, 0x1f, 255]; // fundo-direita (tinta do tema)
const WHITE = [0xff, 0xff, 0xff, 255];
const TURQUOISE = [0x2d, 0xd4, 0xbf, 255];
const CLEAR = [0, 0, 0, 0];

// ── marca: haste + três travessões + sublinhado, em fracção do lado (512) ───
// Geometria centrada opticamente: a bbox do glyph fica centrada em 0.5, 0.5.
const E_BARS = [
  [0.290, 0.2305, 0.420, 0.090], // topo
  [0.290, 0.4160, 0.359, 0.090], // meio
  [0.290, 0.6016, 0.420, 0.090], // fundo
  [0.290, 0.2305, 0.090, 0.461], // haste (encosta nos três travessões)
];
const UNDERLINE = [0.290, 0.7344, 0.420, 0.0352];
const GLYPH_RADIUS = 0.0176; // 9/512 — cantos suaves do E

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

// ── geometria (distâncias normalizadas; negativo = dentro) ───────────────────

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// Superelipse n=5: o "squircle" moderno (cantos mais suaves que um arco).
function sdSquircle(x, y) {
  const dx = Math.abs(x - 0.5) / 0.5;
  const dy = Math.abs(y - 0.5) / 0.5;
  const g = Math.pow(Math.pow(dx, 5) + Math.pow(dy, 5), 1 / 5);
  return (g - 1) * 0.5;
}

function scaleRect([x, y, w, h], s) {
  const cx = 0.5 + (x + w / 2 - 0.5) * s;
  const cy = 0.5 + (y + h / 2 - 0.5) * s;
  return [cx - (w * s) / 2, cy - (h * s) / 2, w * s, h * s];
}

// ── desenho ──────────────────────────────────────────────────────────────────

/**
 * Pinta um ícone.
 *   shape: 'squircle' | 'circle' | 'square' | 'foreground' (só glyph, sem fundo)
 *   glyphScale < 1 mete a marca na zona segura (maskable / adaptativo).
 */
function paintIcon(size, { shape, glyphScale = 1 }) {
  const gR = GLYPH_RADIUS * glyphScale;
  const bars = E_BARS.map((b) => scaleRect(b, glyphScale));
  const under = scaleRect(UNDERLINE, glyphScale);
  const uR = Math.min(under[2], under[3]) / 2;

  const glyphDist = (fx, fy) => {
    let d = Infinity;
    for (const [bx, by, bw, bh] of bars) {
      d = Math.min(d, sdRoundRect(fx, fy, bx + bw / 2, by + bh / 2, bw / 2, bh / 2, Math.min(gR, bw / 2, bh / 2)));
    }
    return d;
  };

  return (px, py) => {
    const fx = (px + 0.5) / size;
    const fy = (py + 0.5) / size;

    const dE = glyphDist(fx, fy);
    const dU = sdRoundRect(fx, fy, under[0] + under[2] / 2, under[1] + under[3] / 2, under[2] / 2, under[3] / 2, uR);
    const eA = clamp01(0.5 - dE * size);
    const uA = clamp01(0.5 - dU * size);

    // Só o glyph (camada adaptativa do Android): fundo transparente.
    if (shape === 'foreground') {
      if (eA <= 0 && uA <= 0) return CLEAR;
      let c = WHITE;
      if (uA > eA) {
        c = TURQUOISE;
        const a = Math.round(uA * 255);
        return [c[0], c[1], c[2], a];
      }
      return [c[0], c[1], c[2], Math.round(eA * 255)];
    }

    const dBg =
      shape === 'squircle'
        ? sdSquircle(fx, fy)
        : shape === 'circle'
          ? sdRoundRect(fx, fy, 0.5, 0.5, 0.5, 0.5, 0.5)
          : sdRoundRect(fx, fy, 0.5, 0.5, 0.5, 0.5, 0);
    const bgA = clamp01(0.5 - dBg * size);
    if (bgA <= 0) return CLEAR;

    // Gradiente diagonal suavizado (topo-esquerda claro → fundo-direita escuro).
    let t = clamp01(fx * 0.45 + fy * 0.55);
    t = t * t * (3 - 2 * t);
    let r = G0[0] + (G1[0] - G0[0]) * t;
    let g = G0[1] + (G1[1] - G0[1]) * t;
    let b = G0[2] + (G1[2] - G0[2]) * t;

    // Brilho de vidro no topo-esquerda.
    const band = clamp01(1 - (fx * 0.55 + fy * 0.75) / 1.15);
    const sheen = 0.14 * band * band;
    // Aro luminoso por dentro da aresta (mais forte em cima).
    const rim = clamp01(1 + (dBg * size) / 3) * (0.45 + 0.55 * (1 - fy)) * 0.16 * bgA;
    const lift = Math.min(1, sheen + rim);
    r += (255 - r) * lift;
    g += (255 - g) * lift;
    b += (255 - b) * lift;

    // Marca por cima (E branco; sublinhado turquesa não se sobrepõe ao E).
    if (eA > 0) {
      r += (WHITE[0] - r) * eA;
      g += (WHITE[1] - g) * eA;
      b += (WHITE[2] - b) * eA;
    }
    if (uA > 0) {
      r += (TURQUOISE[0] - r) * uA;
      g += (TURQUOISE[1] - g) * uA;
      b += (TURQUOISE[2] - b) * uA;
    }

    return [Math.round(r), Math.round(g), Math.round(b), Math.round(bgA * 255)];
  };
}

// ── main ─────────────────────────────────────────────────────────────────────

mkdirSync(OUT, { recursive: true });

const webTargets = [
  { file: 'icon-192.png', size: 192, shape: 'squircle', glyphScale: 1 },
  { file: 'icon-512.png', size: 512, shape: 'squircle', glyphScale: 1 },
  // Maskable: fundo até às bordas e marca dentro dos 80% centrais de segurança.
  { file: 'icon-maskable-512.png', size: 512, shape: 'square', glyphScale: 0.9 },
];

for (const t of webTargets) {
  const buf = encodePng(t.size, paintIcon(t.size, t));
  writeFileSync(join(OUT, t.file), buf);
  console.log(`${t.file}  ${t.size}x${t.size}  ${buf.length} bytes`);
}

// Android (opcional): gera os mipmap da APK a partir da mesma marca.
const androidArg = process.argv.indexOf('--android');
if (androidArg !== -1 && process.argv[androidArg + 1]) {
  const res = process.argv[androidArg + 1];
  const densities = [
    ['mdpi', 48, 108],
    ['hdpi', 72, 162],
    ['xhdpi', 96, 216],
    ['xxhdpi', 144, 324],
    ['xxxhdpi', 192, 432],
  ];
  for (const [name, std, fgd] of densities) {
    const dir = join(res, `mipmap-${name}`);
    mkdirSync(dir, { recursive: true });
    const files = [
      ['ic_launcher.png', std, { shape: 'squircle', glyphScale: 1 }],
      ['ic_launcher_round.png', std, { shape: 'circle', glyphScale: 0.95 }],
      ['ic_launcher_foreground.png', fgd, { shape: 'foreground', glyphScale: 0.88 }],
    ];
    for (const [file, size, opts] of files) {
      const buf = encodePng(size, paintIcon(size, opts));
      writeFileSync(join(dir, file), buf);
      console.log(`mipmap-${name}/${file}  ${size}x${size}  ${buf.length} bytes`);
    }
  }
}
