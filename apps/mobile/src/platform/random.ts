const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";

interface CryptoLike {
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

let nativeSource: CryptoLike | undefined;

/**
 * Registers the native CSPRNG (set once at startup by the app shell) for runtimes whose Hermes has no
 * `globalThis.crypto`. Never a JS PRNG: when neither exists, `randomUrlSafeId` still throws.
 */
export function setNativeRandomSource(source: CryptoLike | undefined): void {
  nativeSource = source;
}

function platformCrypto(): CryptoLike | undefined {
  const g = (globalThis as { crypto?: CryptoLike }).crypto;
  return g?.getRandomValues !== undefined ? g : nativeSource;
}

/**
 * URL-safe random id from the platform CSPRNG. Throws if none exists: callers must fail closed
 * (the analytics tracker turns the throw into a dropped event). Math.random is never used.
 */
export function randomUrlSafeId(length: number, crypto: CryptoLike | undefined = platformCrypto()): string {
  if (crypto?.getRandomValues === undefined) throw new Error("no CSPRNG available");
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) out += ALPHABET.charAt(b % ALPHABET.length);
  return out;
}
