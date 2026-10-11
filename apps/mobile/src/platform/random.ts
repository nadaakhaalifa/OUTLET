const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";

interface CryptoLike {
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

/**
 * URL-safe random id from the platform CSPRNG. Throws if none exists: callers must fail closed
 * (the analytics tracker turns the throw into a dropped event). Math.random is never used.
 */
export function randomUrlSafeId(length: number, crypto: CryptoLike | undefined = (globalThis as { crypto?: CryptoLike }).crypto): string {
  if (crypto?.getRandomValues === undefined) throw new Error("no CSPRNG available");
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) out += ALPHABET.charAt(b % ALPHABET.length);
  return out;
}
