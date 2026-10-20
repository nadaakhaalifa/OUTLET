// Generates icon.png, adaptive layers, splash-icon.png and favicon.png from the shared brand geometry (v2: Playfair Z).
import sharp from "sharp";
import { MONOGRAM_Z, MONOGRAM_EYELET } from "../../apps/mobile/src/art/brand-geometry.ts";

const OUT = new URL("../../apps/mobile/assets/", import.meta.url).pathname;
const INK = "#0B2527", IVORY = "#F4EFE6", SAND = "#D9BFA0", TEAL = "#12403F";

/** Monogram scaled so the 100-unit box spans `frac` of the canvas, centered. */
function mark(size, frac, ink, dot) {
  const s = (size * frac) / 100;
  const t = (size - 100 * s) / 2;
  return `<g transform="translate(${t} ${t}) scale(${s})"><path d="${MONOGRAM_Z}" fill="${ink}"/><circle cx="${MONOGRAM_EYELET.cx}" cy="${MONOGRAM_EYELET.cy}" r="${MONOGRAM_EYELET.r}" fill="${dot}"/></g>`;
}
const svg = (size, body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`);
const bg = (size, c) => `<rect width="${size}" height="${size}" fill="${c}"/>`;

async function write(name, buf, size, flatten) {
  let p = sharp(buf, { density: 144 }).resize(size, size);
  if (flatten) p = p.flatten({ background: INK }).removeAlpha();
  await p.png().toFile(OUT + name);
  console.log("wrote", name);
}

// App icon: ivory Playfair Z on deep teal-black with a sand dot. Splash mark: ink Z with a teal dot on transparent (ivory splash).
await write("icon.png", svg(1024, bg(1024, INK) + mark(1024, 0.78, IVORY, SAND)), 1024, true);
await write("android-icon-background.png", svg(1024, bg(1024, INK)), 1024, true);
await write("android-icon-foreground.png", svg(1024, mark(1024, 0.5, IVORY, SAND)), 1024, false);
await write("android-icon-monochrome.png", svg(1024, mark(1024, 0.5, "#000000", "#000000")), 1024, false);
await write("splash-icon.png", svg(1024, mark(1024, 0.8, INK, TEAL)), 1024, false);
await write("favicon.png", svg(256, bg(256, INK) + mark(256, 0.8, IVORY, SAND)), 256, true);
