import { createHash } from "node:crypto";
import type { EvalContext, FlagRules } from "./types.js";

/** Stable bucket in [0, 10000) from SHA-256(`${key}:${id}`), first 32 bits. */
export const bucketOf = (key: string, id: string): number => {
  const digest = createHash("sha256").update(`${key}:${id}`).digest();
  return digest.readUInt32BE(0) % 10_000;
};

/** True when ctx falls inside rules. No bucketing id and percent < 100 means excluded (never guess). */
export const matchesRules = (key: string, rules: FlagRules, ctx: EvalContext): boolean => {
  if (rules.storeIds && (ctx.storeId === undefined || !rules.storeIds.includes(ctx.storeId))) return false;
  const pct = rules.rolloutPercent ?? 100;
  if (pct >= 100) return true;
  if (pct <= 0) return false;
  const id = ctx.userId ?? ctx.deviceId;
  if (id === undefined) return false;
  return bucketOf(key, id) < pct * 100;
};
