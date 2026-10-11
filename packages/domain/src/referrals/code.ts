/** Crockford base32 without I, L, O, U. 32 symbols, so one random byte maps without modulo bias. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const REFERRAL_CODE_LENGTH = 8;
const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/** Builds a code from CSPRNG bytes (caller supplies at least REFERRAL_CODE_LENGTH). */
export function referralCodeFromBytes(bytes: Uint8Array): string {
  if (bytes.length < REFERRAL_CODE_LENGTH) throw new RangeError("not enough entropy for a referral code");
  let out = "";
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i += 1) out += ALPHABET.charAt((bytes[i] ?? 0) & 31);
  return out;
}

/** Normalises user input (case, separators, look-alikes). Returns null when it cannot be a code. */
export function normalizeReferralCode(input: string): string | null {
  const s = input
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  return CODE_PATTERN.test(s) ? s : null;
}

export function referralDeepLink(baseUrl: string, code: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${code}`;
}
