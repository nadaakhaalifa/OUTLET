/**
 * Gift card codes (spec 15.1): Crockford base32 from a CSPRNG, >= 16 characters.
 * The domain is pure: callers inject the random bytes. The code is shown once and only an HMAC of
 * the canonical form plus the last four characters are ever stored.
 */

/** Crockford alphabet: no I, L, O, U. */
export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 20 characters = 100 bits of entropy. The spec floor is 16. */
export const CODE_LENGTH = 20;
export const CODE_MIN_LENGTH = 16;
const GROUP = 5;
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]+$/;

/** Bytes needed for `chars` base32 characters (5 bits each). */
export const bytesFor = (chars: number): number => Math.ceil((chars * 5) / 8);

/** Encode the leading `chars * 5` bits of `bytes`. Every 5 bit group maps to exactly one symbol, so no modulo bias. */
export function encodeCrockford(bytes: Uint8Array, chars: number): string {
  if (!Number.isInteger(chars) || chars < 1) throw new RangeError("chars must be a positive integer");
  if (bytes.length < bytesFor(chars)) throw new RangeError("not enough random bytes");
  let out = "";
  let acc = 0;
  let bits = 0;
  let i = 0;
  while (out.length < chars) {
    if (bits < 5) {
      acc = (acc << 8) | (bytes[i] ?? 0);
      i += 1;
      bits += 8;
    }
    bits -= 5;
    out += CROCKFORD.charAt((acc >> bits) & 31);
    acc &= (1 << bits) - 1;
  }
  return out;
}

/** Canonical code (no separators) from a CSPRNG source. */
export function generateCode(randomBytes: (n: number) => Uint8Array): string {
  return encodeCrockford(randomBytes(bytesFor(CODE_LENGTH)), CODE_LENGTH);
}

/** Display form: groups of five joined by a hyphen. */
export function formatCode(canonical: string): string {
  const groups: string[] = [];
  for (let i = 0; i < canonical.length; i += GROUP) groups.push(canonical.slice(i, i + GROUP));
  return groups.join("-");
}

/**
 * Canonical form of user input, or null when it cannot be a code. Applies the Crockford read
 * rules: case folding, I and L read as 1, O read as 0, separators ignored.
 */
export function normalizeCode(input: string): string | null {
  const s = input
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (s.length < CODE_MIN_LENGTH || s.length > 32) return null;
  return CODE_RE.test(s) ? s : null;
}

export function last4(canonical: string): string {
  return canonical.slice(-4);
}
