import { z } from "zod";

export const MAX_PAGE_SIZE = 50;
export const DEFAULT_PAGE_SIZE = 20;

/** Keyset pagination query (contract parameters Cursor + Limit). The cursor is opaque base64url; no OFFSET exists. */
export const CursorQuery = z.strictObject({
  cursor: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/, "opaque base64url cursor").optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
export type CursorQuery = z.infer<typeof CursorQuery>;

/** Response envelope `{ items, next_cursor }` (null on the last page). */
export const pageOf = <T extends z.ZodType>(item: T): z.ZodObject<{ items: z.ZodArray<T>; next_cursor: z.ZodNullable<z.ZodString> }> =>
  z.strictObject({ items: z.array(item).max(MAX_PAGE_SIZE), next_cursor: z.string().max(512).nullable() });
