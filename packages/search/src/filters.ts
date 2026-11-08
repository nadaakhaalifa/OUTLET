import { z } from "zod";

export const MAX_PAGE = 50;
export const DEFAULT_PAGE = 24;
export const MAX_FACET_VALUES = 30;

const minor = z.bigint().nonnegative();

/** Mirrors openapi SearchFilter (subset built in Phase 1). Strict: unknown keys are rejected. Max 30 facet values in total (API4). */
export const searchFilterSchema = z
  .strictObject({
    world: z.enum(["local", "global", "both"]).optional(),
    categoryIds: z.array(z.uuid()).max(50).optional(),
    storeIds: z.array(z.uuid()).max(50).optional(),
    conditionGrades: z.array(z.string().min(1).max(500)).max(50).optional(),
    sizes: z.array(z.string().min(1).max(32)).max(50).optional(),
    priceMin: minor.optional(),
    priceMax: minor.optional(),
    verifiedOnly: z.boolean().optional(),
    lowest30d: z.boolean().optional(),
    inStockOnly: z.boolean().optional(),
  })
  .refine((f) => (f.categoryIds?.length ?? 0) + (f.storeIds?.length ?? 0) + (f.conditionGrades?.length ?? 0) + (f.sizes?.length ?? 0) <= MAX_FACET_VALUES, {
    message: `at most ${String(MAX_FACET_VALUES)} facet values`,
  });

export type SearchFilters = z.infer<typeof searchFilterSchema>;
