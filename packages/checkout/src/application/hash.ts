import { createHash } from "node:crypto";

export const sha256Hex = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");
export const sha256Bytes = (s: string | Uint8Array): Buffer => createHash("sha256").update(s).digest();
