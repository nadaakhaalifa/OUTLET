import type { Kysely } from "kysely";

/** Raw SQL only, rows validated with Zod (same approach as the returns and cart adapters). */
export type SellerAnalyticsDb = Kysely<Record<string, never>>;
