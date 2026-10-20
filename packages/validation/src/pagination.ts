import { z } from "zod";

export const MAX_PAGE_LIMIT = 50;
export const DEFAULT_PAGE_LIMIT = 20;

/**
 * Opaque cursor: URL-safe base64 characters only, at most 512. Clients must not interpret it;
 * servers sign or encode their own payload behind it.
 */
export const CursorSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+={0,2}$/, "cursor must be URL-safe base64");

export const PaginationQuerySchema = z
  .object({
    cursor: CursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  })
  .strict();
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export const PageInfoSchema = z
  .object({ next_cursor: CursorSchema.nullable(), has_more: z.boolean() })
  .strict();
export type PageInfo = z.infer<typeof PageInfoSchema>;
