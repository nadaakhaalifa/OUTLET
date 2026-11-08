import { revalidateTag } from "next/cache";

/**
 * Cache tag convention (one tag per cacheable catalogue object):
 *   product:{id}   store:{slug}   market:{id}
 * Tags are for descriptive catalogue data only (names, images, shelves). Price and stock are NEVER read through a
 * tagged or cached fetch: loaders for them use `cache: "no-store"` (spec section 3).
 */
export const tags = {
  product: (id: string): string => `product:${id}`,
  store: (slug: string): string => `store:${slug}`,
  market: (id: string): string => `market:${id}`,
} as const;

/** Invalidates tags from a trusted server path (webhook or outbox consumer). `max` = stale-while-revalidate. */
export function revalidateTags(names: readonly string[]): void {
  for (const name of names) revalidateTag(name, "max");
}
