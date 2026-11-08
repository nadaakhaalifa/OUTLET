import { Hasher, safeEqual } from "./crypto.js";
import { AuthError } from "./errors.js";
import type { FieldCipher } from "./ports.js";

export interface MarketAuthPolicy {
  /** E.164 prefixes allowed to receive OTPs (SMS-pumping control). Launch: Egypt only. */
  readonly allowedPhonePrefixes: readonly string[];
  /** Full-number shape check applied after the prefix check (rejects numbers no operator issues). */
  readonly phonePattern: RegExp;
}

export const DEFAULT_MARKET_POLICIES: Readonly<Record<string, MarketAuthPolicy>> = {
  EG: { allowedPhonePrefixes: ["+20"], phonePattern: /^\+20(10|11|12|15)\d{8}$/ },
};

const AUTH_DEPS_BRAND: unique symbol = Symbol("AuthDeps");

/** Only createAuthDeps can build this (the brand symbol is not exported). */
export interface AuthDeps {
  readonly [AUTH_DEPS_BRAND]: true;
  readonly hasher: Hasher;
  readonly cipher: FieldCipher;
}

/**
 * Builds AuthDeps and refuses to share one key between the blind-index HMAC and field encryption
 * (a shared key would let a blind index be correlated with ciphertext material).
 */
export const createAuthDeps = (input: {
  readonly hmacKey: Uint8Array;
  readonly cipherKey: Uint8Array;
  readonly cipher: FieldCipher;
}): AuthDeps => {
  if (safeEqual(input.hmacKey, input.cipherKey)) throw new AuthError("INSECURE_CONFIG", "HMAC key and cipher key must differ");
  return { [AUTH_DEPS_BRAND]: true, hasher: new Hasher(input.hmacKey), cipher: input.cipher };
};
