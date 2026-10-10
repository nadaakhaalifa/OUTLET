import type { Clock, Hasher } from './ports.js';

/** Development fixture clock. */
export function fixedClock(iso: string): Clock {
  return { now: () => new Date(iso) };
}

/**
 * Development fixture hasher: NOT cryptographic. Deterministic 32-hex FNV-style
 * mix, used only by tests.
 */
export const fakeHasher: Hasher = (input) => {
  let h1 = 0x811c9dc5;
  let h2 = 0xdeadbeef;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
  }
  const hex = (n: number) => n.toString(16).padStart(8, '0');
  return hex(h1) + hex(h2) + hex((h1 ^ h2) >>> 0) + hex((h1 + h2) >>> 0);
};
