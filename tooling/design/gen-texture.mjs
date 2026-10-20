// Deterministic paper/linen grain tiles for the wallpaper overlay. Node built-ins only.
// Output: apps/mobile/assets/textures/paper-{dark,light}{,@2x,@3x}.png (RGBA, constant colour, noise in alpha).
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const out = join(dirname(fileURLToPath(import.meta.url)), "../../apps/mobile/assets/textures");
mkdirSync(out, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const t = Buffer.from(type, "ascii"); const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
};
function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function png(size, rgb, seed) {
  const rnd = mulberry(seed);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  // Periodic weave: sin of integer multiples over the tile so edges wrap exactly (seamless).
  const wx = Math.max(2, Math.round(size / 8)), wy = Math.max(2, Math.round(size / 6));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1); raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const weave = 0.5 + 0.25 * Math.sin((2 * Math.PI * wx * x) / size) * Math.sin((2 * Math.PI * wy * y) / size);
      const n = rnd() * 0.75 + weave * 0.25;
      const a = Math.round(Math.pow(n, 1.6) * 255); // alpha carries the grain
      const o = row + 1 + x * 4; raw[o] = rgb; raw[o + 1] = rgb; raw[o + 2] = rgb; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
const scales = [["", 128], ["@2x", 256], ["@3x", 384]];
for (const [name, rgb, seed] of [["dark", 0, 11], ["light", 255, 29]]) {
  for (const [suf, size] of scales) writeFileSync(join(out, `paper-${name}${suf}.png`), png(size, rgb, seed + size));
}
console.log("textures written");
