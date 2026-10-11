import { createHash } from "node:crypto";

/** Deterministic UUID (v4 shape) from a seed: stable ids for retried side effects. */
export function derivedUuid(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  const variant = ((Number.parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
