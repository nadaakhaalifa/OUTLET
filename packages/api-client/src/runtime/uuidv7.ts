/** RFC 9562 UUIDv7 from a millisecond timestamp and 10 random bytes. */
export function uuidv7(nowMs: number, rand: Uint8Array): string {
  if (rand.length < 10) throw new Error("uuidv7 needs 10 random bytes");
  const b = new Uint8Array(16);
  let t = Math.floor(nowMs);
  for (let i = 5; i >= 0; i--) {
    b[i] = t % 256;
    t = Math.floor(t / 256);
  }
  for (let i = 0; i < 10; i++) b[6 + i] = rand[i] ?? 0;
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x70;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function defaultRandomBytes(n: number): Uint8Array {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues === undefined) throw new Error("no CSPRNG available: inject randomBytes");
  return c.getRandomValues(new Uint8Array(n));
}
