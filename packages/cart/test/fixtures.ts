import { randomUUID } from "node:crypto";
import type { RoleSqlClient, SqlClient } from "@outlet/db";
import { createTestClient, roleClient } from "@outlet/db/testing";
import type { Principal } from "@outlet/policy";
import { CartService, pgInventoryAvailability } from "../src/index.js";
import type { AvailabilityPort, CartDeps } from "../src/index.js";

export interface Sku { readonly skuId: string; readonly productId: string; readonly storeId: string }

export interface World {
  readonly raw: SqlClient;
  readonly app: RoleSqlClient<"outlet_app">;
  readonly deps: CartDeps;
  readonly svc: CartService;
  readonly userA: string;
  readonly userB: string;
  readonly storeA: string;
  readonly storeB: string;
  readonly close: () => Promise<void>;
  readonly seedSku: (storeId: string, priceMinor: number, stock?: number) => Promise<Sku>;
  readonly setPrice: (s: Sku, priceMinor: number) => Promise<void>;
  readonly setListingStatus: (s: Sku, status: "PUBLISHED" | "SOLD_OUT" | "PAUSED") => Promise<void>;
  readonly setStock: (s: Sku, onHand: number) => Promise<void>;
  readonly suspendStore: (storeId: string) => Promise<void>;
  readonly events: () => Promise<{ type: string; payload: Record<string, unknown> }[]>;
}

const uuid = (): string => randomUUID();

export const staffOf = (storeId: string, roles: readonly string[] = ["owner"]): Principal => ({ kind: "seller_staff", userId: uuid(), marketId: "EG", storeIds: [storeId], roles: [...roles], scopes: [] });

export const buildWorld = async (o: { availability?: "inventory" | AvailabilityPort; defaultThresholdMinor?: bigint } = {}): Promise<World> => {
  const { client: raw, close } = await createTestClient();
  const app = roleClient(raw, "outlet_app");
  const T = "2030-01-01T00:00:00.000Z";
  const userA = uuid();
  const userB = uuid();
  for (const u of [userA, userB]) await raw.query("INSERT INTO users (id, market_id, created_at, updated_at) VALUES ($1,'EG',$2,$2)", [u, T]);
  const mkStore = async (slug: string): Promise<string> => {
    const sellerId = uuid();
    const storeId = uuid();
    await raw.query(
      `INSERT INTO sellers (id, home_market_id, market_id, legal_type, legal_name_ar, legal_name_en, commercial_register_no, tax_card_no, governorate_code, governorate_name_ar, status)
       VALUES ($1,'EG','EG','company','شركة','Company',$2,$3,'CAI','القاهرة','active')`,
      [sellerId, `CR-${slug}`, `TX-${slug}`],
    );
    await raw.query(
      `INSERT INTO stores (id, seller_id, market_id, slug, display_name_ar, kind, ships_from_country, status) VALUES ($1,$2,'EG',$3,$4,'local','EG','ACTIVE')`,
      [storeId, sellerId, slug, `متجر ${slug}`],
    );
    await raw.query(
      `INSERT INTO catalog_public_stores (id, market_id, slug, display_name_ar, kind, status, verified_badge, ships_from_country, followers_count, discount_display_mode, legal_identity, updated_at)
       VALUES ($1,'EG',$2,$3,'local','ACTIVE',false,'EG',0,'public','{}'::jsonb,$4)`,
      [storeId, slug, `متجر ${slug}`, T],
    );
    await raw.query("INSERT INTO inventory_locations (id, market_id, store_id) VALUES ($1,'EG',$2)", [uuid(), storeId]);
    return storeId;
  };
  const storeA = await mkStore("store-a");
  const storeB = await mkStore("store-b");

  const republish = async (productId: string): Promise<void> => {
    const r = await raw.query<{ id: string; price_minor: string | bigint; currency: string; option_values: unknown }>("SELECT id, price_minor, currency, option_values FROM skus WHERE product_id = $1 AND status = 'active'", [productId]);
    const variants = r.rows.map((s) => ({ sku_id: s.id, option_values: s.option_values, price_minor: s.price_minor.toString(), currency: s.currency }));
    await raw.query("UPDATE catalog_public_listings SET variants = $2::jsonb WHERE id = $1", [productId, JSON.stringify(variants)]);
  };
  const seedSku: World["seedSku"] = async (storeId, price, stock = 5) => {
    const productId = uuid();
    const skuId = uuid();
    await raw.query(
      `INSERT INTO products (id, store_id, market_id, primary_category_id, status, title_ar, description_ar, condition_grade_code, published_at)
       VALUES ($1,$2,'EG','00000000-0000-4000-8000-0000000c0011','PUBLISHED','فستان','وصف','new_with_tags',$3)`,
      [productId, storeId, T],
    );
    await raw.query("INSERT INTO skus (id, product_id, store_id, market_id, seller_sku, price_minor, currency) VALUES ($1,$2,$3,'EG',$4,$5,'EGP')", [skuId, productId, storeId, `S-${skuId}`, price]);
    await raw.query(
      `INSERT INTO catalog_public_listings (id, store_ref, market_id, store, status, title_ar, description_ar, primary_category_id, condition_grade_code, condition_grade, min_price_minor, currency, attributes, variants, version, published_at, updated_at)
       VALUES ($1,$2,'EG','{}'::jsonb,'PUBLISHED','فستان','وصف','00000000-0000-4000-8000-0000000c0011','new_with_tags','{}'::jsonb,$3,'EGP','{}'::jsonb,'[]'::jsonb,1,$4,$4)`,
      [productId, storeId, price, T],
    );
    await republish(productId);
    const sku: Sku = { skuId, productId, storeId };
    await raw.query(
      "INSERT INTO inventory_levels (sku_id, location_id, store_id, market_id, on_hand) SELECT $1, id, $2, 'EG', $3 FROM inventory_locations WHERE store_id = $2",
      [skuId, storeId, stock],
    );
    return sku;
  };

  let tick = Date.parse(T);
  const availability = o.availability === undefined ? undefined : o.availability === "inventory" ? pgInventoryAvailability(app, "EG") : o.availability;
  const deps: CartDeps = { client: app, marketId: "EG", now: () => new Date((tick += 1000)), ...(availability === undefined ? {} : { availability }), ...(o.defaultThresholdMinor === undefined ? {} : { defaultThresholdMinor: o.defaultThresholdMinor }) };
  return {
    raw, app, deps, svc: new CartService(deps), userA, userB, storeA, storeB, close, seedSku,
    setPrice: async (s, p) => {
      await raw.query("UPDATE skus SET price_minor = $2 WHERE id = $1", [s.skuId, p]);
      await republish(s.productId);
    },
    setListingStatus: async (s, status) => {
      await raw.query("UPDATE catalog_public_listings SET status = $2 WHERE id = $1", [s.productId, status]);
    },
    setStock: async (s, onHand) => {
      await raw.query("UPDATE inventory_levels SET on_hand = $2 WHERE sku_id = $1", [s.skuId, onHand]);
    },
    suspendStore: async (storeId) => {
      await raw.query("DELETE FROM catalog_public_listings WHERE store_ref = $1", [storeId]);
      await raw.query("DELETE FROM catalog_public_stores WHERE id = $1", [storeId]);
    },
    events: async () => (await raw.query<{ type: string; payload: Record<string, unknown> }>("SELECT event_type AS type, payload FROM outbox_events ORDER BY occurred_at, id")).rows,
  };
};

export const errorCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof Error && "code" in e && typeof e.code === "string") return e.code;
    throw e;
  }
  return "NO_ERROR";
};
