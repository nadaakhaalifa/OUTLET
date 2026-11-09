/** RFC 9562 UUIDv7 (48-bit unix ms + random), the Idempotency-Key format the API contract asks clients to generate. Browser and Node. */
export function uuidv7(now: number = Date.now(), random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const b = random(16);
  let ms = BigInt(Math.max(0, Math.trunc(now)));
  for (let i = 5; i >= 0; i--) {
    b[i] = Number(ms & 0xffn);
    ms >>= 8n;
  }
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x70;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
