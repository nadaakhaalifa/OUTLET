import { z } from "zod";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Canonical lowercase UUIDv7 (version nibble 7, RFC 4122 variant). */
export const uuidV7Schema = z.string().regex(UUID_V7, "must be a UUIDv7");
export type UuidV7 = z.infer<typeof uuidV7Schema>;

const MAX_SEQ = 0xfff; // 12-bit counter held in rand_a

let lastMs = -1;
let seq = 0;

const hex = (n: number | bigint, width: number): string => n.toString(16).padStart(width, "0");

/**
 * RFC 9562 UUIDv7: 48-bit unix ms, 12-bit rand_a, 62-bit rand_b.
 * Monotonic within a process: ids generated in the same millisecond (or with a
 * clock that went backwards) increase through a counter in rand_a; if the
 * counter overflows, the timestamp is advanced by 1 ms instead of repeating.
 */
export const uuidv7 = (nowMs: number = Date.now()): UuidV7 => {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 0xffff_ffff_ffff) {
    throw new RangeError("uuidv7: timestamp out of 48-bit range");
  }
  if (nowMs > lastMs) {
    lastMs = nowMs;
    // Start the counter low-ish at random so ids from separate processes are not identical in rand_a.
    seq = (crypto.getRandomValues(new Uint16Array(1))[0] ?? 0) & 0x3ff;
  } else if (seq < MAX_SEQ) {
    seq += 1;
  } else {
    lastMs += 1;
    seq = 0;
  }
  const rb = crypto.getRandomValues(new Uint8Array(8));
  rb[0] = ((rb[0] ?? 0) & 0x3f) | 0x80; // variant 10
  let tail = 0n;
  for (const b of rb) tail = (tail << 8n) | BigInt(b);
  const t = hex(lastMs, 12);
  const tailHex = hex(tail, 16);
  return `${t.slice(0, 8)}-${t.slice(8)}-7${hex(seq, 3)}-${tailHex.slice(0, 4)}-${tailHex.slice(4)}`;
};

/** Unix ms embedded in a UUIDv7. */
export const uuidV7Timestamp = (id: string): number => {
  uuidV7Schema.parse(id);
  return parseInt(id.replaceAll("-", "").slice(0, 12), 16);
};
