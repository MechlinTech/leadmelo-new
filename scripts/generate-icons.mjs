// Generates the PNG app icons from the LeadMelo mark (the wave in public/icons/logo.svg) with no image
// dependencies: a supersampled software rasteriser plus a minimal PNG writer. Run: node scripts/generate-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); };
function png(size, rgba) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// The wave from logo.svg in a 64-unit box: M12 36 c9-17 16-17 24 0 s15 17 20 1
const bez = (p0, p1, p2, p3, t) => { const u = 1 - t; return [u ** 3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t ** 3 * p3[0], u ** 3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1]]; };
const wave = [];
for (let i = 0; i <= 200; i++) wave.push(bez([12, 36], [21, 19], [28, 19], [36, 36], i / 200));
for (let i = 1; i <= 200; i++) wave.push(bez([36, 36], [44, 53], [51, 53], [56, 37], i / 200));
const lerp = (a, b, t) => a + (b - a) * t;

// bleed=true fills the whole square (maskable and Apple icons, which the OS crops itself);
// otherwise the artwork is a rounded square like the SVG logo.
function render(size, { bleed, scale }) {
  const SS = 3, N = size * SS, out = Buffer.alloc(size * size * 4);
  const acc = new Float64Array(size * size * 4);
  const radius = bleed ? 0 : (18 / 64) * N;
  const u = N / 64;
  const cx = 32, tx = p => (32 + (p - 32) * scale) * u;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    // rounded-square coverage
    let inside = true;
    if (!bleed) { const dx = Math.max(radius - x, 0, x - (N - 1 - radius)), dy = Math.max(radius - y, 0, y - (N - 1 - radius)); inside = dx * dx + dy * dy <= radius * radius; }
    if (!inside) continue;
    let r = 16, g = 19, b = 29; // #10131d
    // stroke: distance to the polyline, radius 4 units
    const px = x / u, py = y / u; let best = Infinity, bestT = 0;
    for (let i = 0; i < wave.length; i += 2) { const wx = 32 + (wave[i][0] - 32) * scale, wy = 32 + (wave[i][1] - 32) * scale; const d = (px - wx) ** 2 + (py - wy) ** 2; if (d < best) { best = d; bestT = i / (wave.length - 1); } }
    if (Math.sqrt(best) <= 4 * scale) { r = lerp(139, 34, bestT); g = lerp(92, 211, bestT); b = lerp(246, 238, bestT); } // #8b5cf6 -> #22d3ee
    const o = ((Math.floor(y / SS)) * size + Math.floor(x / SS)) * 4;
    acc[o] += r; acc[o + 1] += g; acc[o + 2] += b; acc[o + 3] += 1;
  }
  for (let i = 0; i < size * size; i++) { const n = acc[i * 4 + 3]; if (!n) continue; out[i * 4] = acc[i * 4] / n; out[i * 4 + 1] = acc[i * 4 + 1] / n; out[i * 4 + 2] = acc[i * 4 + 2] / n; out[i * 4 + 3] = Math.round(255 * n / (SS * SS)); }
  void cx; void tx;
  return out;
}
const outputs = [['public/icons/icon-192.png', 192, { bleed: false, scale: 1 }], ['public/icons/icon-512.png', 512, { bleed: false, scale: 1 }], ['public/icons/maskable-512.png', 512, { bleed: true, scale: 0.68 }], ['public/icons/apple-touch-icon.png', 180, { bleed: true, scale: 0.8 }]];
for (const [file, size, opts] of outputs) { writeFileSync(file, png(size, render(size, opts))); console.log('wrote', file); }
