/**
 * The single seam to the shared pure inventory domain (packages/domain/src/inventory). Everything
 * else in the inventory module imports this file, never the shared package directly.
 */
export * from "@outlet/domain";
