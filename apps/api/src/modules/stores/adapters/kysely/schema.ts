import type { ColumnType, Generated } from "kysely";
import type { PlatformTables } from "../../../../platform/db";

/** Hand-written row types for migration 0013 (ADR-0020 option A), drift-tested by STORES_COLUMNS. */
export interface StoresTable {
  id: string;
  seller_id: string;
  kind: "local" | "global";
  slug: string;
  name_ar: string;
  name_en: string | null;
  description_ar: string | null;
  description_en: string | null;
  status: Generated<"DRAFT" | "ACTIVE" | "PAUSED" | "SUSPENDED">;
  seller_kyc_state: Generated<string>;
  health_score: number | null;
  verified_badge: Generated<boolean>;
  logo_url: string | null;
  cover_url: string | null;
  free_delivery_threshold_amount: ColumnType<string, string, string>;
  currency: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface StoreDirectoryStatsTable {
  store_id: string;
  follower_count: Generated<number>;
  max_verified_discount_pct: number | null;
  rating_avg: ColumnType<string | null, string | null, string | null>;
  rating_count: Generated<number>;
  live_drop: Generated<boolean>;
  trending_score: Generated<number>;
  last_drop_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  p80_delivery_hours: number | null;
  refreshed_at: Generated<Date>;
}

export interface StoreLegalIdentityPublicTable {
  store_id: string;
  legal_name_ar: string;
  legal_name_en: string | null;
  commercial_register_no: string | null;
  tax_card_no: string | null;
  governorate: string;
  published_at: Generated<Date>;
}

export interface UserFavoriteStoresTable {
  user_id: string;
  store_id: string;
  position: number;
  last_seen_at: ColumnType<Date, Date | string, Date | string>;
  created_at: Generated<Date>;
}

export interface StoreActivityEventsTable {
  id: Generated<string>;
  store_id: string;
  kind: "product_published" | "drop_scheduled";
  occurred_at: ColumnType<Date, Date | string, Date | string>;
  created_at: Generated<Date>;
}

export interface StoresTables {
  stores: StoresTable;
  store_directory_stats: StoreDirectoryStatsTable;
  store_legal_identity_public: StoreLegalIdentityPublicTable;
  user_favorite_stores: UserFavoriteStoresTable;
  store_activity_events: StoreActivityEventsTable;
}

export type StoresDb = PlatformTables & StoresTables;

const cols = <T>(m: Record<keyof T, true>): readonly string[] => Object.keys(m).sort();

export const STORES_COLUMNS: Record<keyof StoresTables, readonly string[]> = {
  stores: cols<StoresTable>({ id: true, seller_id: true, kind: true, slug: true, name_ar: true, name_en: true, description_ar: true, description_en: true, status: true, seller_kyc_state: true, health_score: true, verified_badge: true, logo_url: true, cover_url: true, free_delivery_threshold_amount: true, currency: true, created_at: true, updated_at: true }),
  store_directory_stats: cols<StoreDirectoryStatsTable>({ store_id: true, follower_count: true, max_verified_discount_pct: true, rating_avg: true, rating_count: true, live_drop: true, trending_score: true, last_drop_at: true, p80_delivery_hours: true, refreshed_at: true }),
  store_legal_identity_public: cols<StoreLegalIdentityPublicTable>({ store_id: true, legal_name_ar: true, legal_name_en: true, commercial_register_no: true, tax_card_no: true, governorate: true, published_at: true }),
  user_favorite_stores: cols<UserFavoriteStoresTable>({ user_id: true, store_id: true, position: true, last_seen_at: true, created_at: true }),
  store_activity_events: cols<StoreActivityEventsTable>({ id: true, store_id: true, kind: true, occurred_at: true, created_at: true }),
};
