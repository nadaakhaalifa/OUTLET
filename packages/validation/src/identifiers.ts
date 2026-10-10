import { z } from "zod";

/** RFC 9562 UUIDv7: version nibble 7, variant 10xx. Lowercase on output, case-insensitive on input. */
export const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const UuidV7Schema = z.string().regex(UUID_V7_PATTERN, "must be a UUIDv7").transform((s) => s.toLowerCase());

/** Client generated key for money, stock and order writes (spec T5). */
export const IdempotencyKeySchema = UuidV7Schema;

/** Any UUID version, for identifiers the server minted (opaque, never sequential). */
export const UuidSchema = z.uuid().transform((s) => s.toLowerCase());

/**
 * Pure UUIDv7 construction. Time and entropy are injected so callers stay deterministic
 * in tests: `unixMs` is epoch milliseconds, `random` is at least 10 CSPRNG bytes.
 */
export function formatUuidV7(unixMs: number, random: Uint8Array): string {
  if (!Number.isSafeInteger(unixMs) || unixMs < 0 || unixMs >= 2 ** 48) {
    throw new RangeError("unixMs must be an integer in [0, 2^48)");
  }
  if (random.length < 10) throw new RangeError("random must provide at least 10 bytes");
  const b = new Uint8Array(16);
  let t = unixMs;
  for (let i = 5; i >= 0; i--) {
    b[i] = t % 256;
    t = Math.floor(t / 256);
  }
  for (let i = 0; i < 10; i++) b[6 + i] = random[i] ?? 0;
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x70;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
