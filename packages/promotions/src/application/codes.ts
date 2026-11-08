import { createHmac, randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32
export const CODE_LENGTH = 20;

/** >= 16 chars from a CSPRNG (20 here = 100 bits). Rejection sampling is unnecessary: 256 is a multiple of 32. */
export const generateCode = (bytes: (n: number) => Uint8Array = randomBytes): string =>
  Array.from(bytes(CODE_LENGTH), (b) => ALPHABET[b % 32]).join("");

/** Crockford normalisation: uppercase, strip separators, I/L -> 1, O -> 0. */
export const normaliseCode = (raw: string): string => raw.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");

export const hashCode = (key: Uint8Array, code: string): Buffer => createHmac("sha256", key).update(normaliseCode(code)).digest();
export const last4 = (code: string): string => normaliseCode(code).slice(-4);
