/** UUIDv7 (RFC 9562) for Idempotency-Key. Works in the browser and on the server. */
export function uuidv7(now: number = Date.now(), rnd: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const b = rnd(16);
  const ts = BigInt(now);
  for (let i = 0; i < 6; i += 1) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x70;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
