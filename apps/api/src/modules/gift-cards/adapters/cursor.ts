import { z } from "zod";
import type { KeysetPos } from "../domain/ports";

/** Opaque keyset cursor: base64url(JSON {ms,id}). A malformed cursor fails Zod and becomes a 400. */
export const KeysetCursor = z
  .string()
  .min(1)
  .max(200)
  .transform((s, ctx): KeysetPos => {
    try {
      const v = z.object({ ms: z.number().int().nonnegative(), id: z.uuid() }).strict().parse(JSON.parse(Buffer.from(s, "base64url").toString("utf8")));
      return { ms: v.ms, id: v.id.toLowerCase() };
    } catch {
      ctx.addIssue({ code: "custom", message: "invalid cursor" });
      return z.NEVER;
    }
  });

export const encodeCursor = (p: KeysetPos | null): string | null => (p === null ? null : Buffer.from(JSON.stringify({ ms: p.ms, id: p.id })).toString("base64url"));
