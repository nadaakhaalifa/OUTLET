import type { Csprng } from "./ports";

/** Development fixture: deterministic xorshift bytes. NEVER use outside tests. */
export function seededRng(seed: number): Csprng {
  let s = (seed | 0) || 0x9e3779b9;
  return {
    randomBytes(n) {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        out[i] = s & 0xff;
      }
      return out;
    },
  };
}
