// WCAG 2.2 contrast check for packages/ui-tokens/tokens.json. Plain Node, no dependencies.
// Run: node tooling/design/contrast.mjs   (exit code 1 if any pair fails)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tokens = JSON.parse(readFileSync(join(root, "packages/ui-tokens/tokens.json"), "utf8"));

function get(path) {
  return path.split(".").reduce((o, k) => o?.[k], tokens);
}
function resolve(value) {
  let v = value;
  while (typeof v === "string" && v.startsWith("{")) v = get(v.slice(1, -1)).$value;
  return v;
}
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
function ratio(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// [foreground token, background token, minimum ratio, kind]
// text = 4.5 (normal text). ui = 3 (focus rings, borders of inputs, icons; WCAG 1.4.11 and 2.4.13).
const pairs = [
  ["text.primary", "bg.page", 4.5, "text"],
  ["text.primary", "bg.surface", 4.5, "text"],
  ["text.primary", "bg.subtle", 4.5, "text"],
  ["text.secondary", "bg.page", 4.5, "text"],
  ["text.secondary", "bg.surface", 4.5, "text"],
  ["text.secondary", "bg.subtle", 4.5, "text"],
  ["text.muted", "bg.page", 4.5, "text"],
  ["text.muted", "bg.surface", 4.5, "text"],
  ["text.muted", "bg.subtle", 4.5, "text"],
  ["text.link", "bg.page", 4.5, "text"],
  ["text.link", "bg.surface", 4.5, "text"],
  ["text.inverse", "bg.inverse", 4.5, "text"],
  ["action.primary.text", "action.primary.bg", 4.5, "text"],
  ["action.primary.text", "action.primary.bgHover", 4.5, "text"],
  ["action.secondary.text", "action.secondary.bg", 4.5, "text"],
  ["discount.text", "discount.bg", 4.5, "text"],
  ["savings.text", "bg.page", 4.5, "text"],
  ["savings.text", "bg.surface", 4.5, "text"],
  ["savings.onBg", "savings.bg", 4.5, "text"],
  ["warning.text", "warning.bg", 4.5, "text"],
  ["warning.text", "bg.page", 4.5, "text"],
  ["critical.text", "critical.bg", 4.5, "text"],
  ["critical.text", "bg.page", 4.5, "text"],
  ["verified.text", "verified.bg", 4.5, "text"],
  ["verified.text", "bg.page", 4.5, "text"],
  ["focus.ring", "bg.page", 3, "ui"],
  ["focus.ring", "bg.surface", 3, "ui"],
  ["border.input", "bg.page", 3, "ui"],
  ["border.input", "bg.surface", 3, "ui"],
  ["discount.bg", "bg.page", 1, "info: pill fill (text inside carries meaning; contrast of text checked above)"],
];

let failed = 0;
const rows = [];
for (const theme of ["light", "dark"]) {
  for (const [fg, bg, min, kind] of pairs) {
    const f = resolve(get(`theme.${theme}.${fg}`).$value);
    const b = resolve(get(`theme.${theme}.${bg}`).$value);
    const r = ratio(f, b);
    const ok = r >= min;
    if (!ok) failed++;
    rows.push(`| ${theme} | ${fg} ${f} | ${bg} ${b} | ${r.toFixed(2)} | ${min} | ${ok ? "pass" : "FAIL"} |`);
  }
}
console.log("| theme | foreground | background | ratio | min | result |");
console.log("|---|---|---|---|---|---|");
console.log(rows.join("\n"));
console.log(failed ? `\n${failed} pair(s) failed` : "\nAll pairs pass WCAG 2.2 AA");
process.exit(failed ? 1 : 0);
