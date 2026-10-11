/** Perceptual-hash helpers and GTIN validation. 64-bit hashes are 16 lowercase hex characters. */

export const HASH_BITS = 64;
/** Hamming distance at or under which two 64-bit pHash/dHash values count as a near-duplicate image. */
export const HAMMING_NEAR_DUPLICATE_MAX = 6;

const HASH_RE = /^[0-9a-f]{16}$/;
export const isHash64 = (h: string): boolean => HASH_RE.test(h);

const POP = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) t[i] = (t[i >> 1] ?? 0) + (i & 1);
  return t;
})();

/** Hamming distance of two 64-bit hex hashes; null when either is malformed. */
export function hamming64(a: string, b: string): number | null {
  if (!isHash64(a) || !isHash64(b)) return null;
  let d = 0;
  for (let i = 0; i < 16; i += 2) {
    const x = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16);
    d += POP[x] ?? 0;
  }
  return d;
}

/** GTIN-8/12/13/14 with a valid mod-10 check digit, normalised to 14 digits; null when invalid. */
export function normalizeGtin(raw: string): string | null {
  const s = raw.replace(/[\s-]/g, "");
  if (!/^\d+$/.test(s) || ![8, 12, 13, 14].includes(s.length)) return null;
  const p = s.padStart(14, "0");
  let sum = 0;
  for (let i = 0; i < 13; i += 1) sum += Number(p[i]) * (i % 2 === 0 ? 3 : 1);
  const check = (10 - (sum % 10)) % 10;
  if (check !== Number(p[13])) return null;
  if (/^0{14}$/.test(p)) return null;
  return p;
}

/** Cosine similarity of two equal-length vectors; null on length mismatch, empty or zero vectors. */
export function cosine(a: readonly number[], b: readonly number[]): number | null {
  if (a.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (na === 0 || nb === 0 || !Number.isFinite(denom) || denom === 0) return null;
  const c = dot / denom;
  return Number.isFinite(c) ? Math.max(-1, Math.min(1, c)) : null;
}
