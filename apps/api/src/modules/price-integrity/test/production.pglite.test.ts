import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { loadConfig } from "../../../config/env";
import { bootProduction, PROD_ENV, type ProductionTestApp } from "../../../production/test/test-support";
import { NoProductionAdaptersError } from "../../../platform/platform.module";
import { PriceIntegrityModule, PRICE_INTEGRITY_SERVICE, type PriceIntegrityService } from "../index";

const u = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;
const STORE = u(900);
const DAY = 86_400_000;

describe("price-integrity composed in production (Kysely stores, SKU directory over products and skus)", () => {
  let t: ProductionTestApp;
  let svc: PriceIntegrityService;
  beforeAll(async () => {
    t = await bootProduction();
    svc = t.app.get<PriceIntegrityService>(PRICE_INTEGRITY_SERVICE, { strict: false });
    await sql`select set_config('app.role', 'system', false)`.execute(t.db);
    await sql`set session_replication_role = replica`.execute(t.db);
    await sql`insert into products (id, store_id, category_id, title_ar, condition, status, description_ar) values
      (${u(1)}::uuid, ${STORE}::uuid, ${u(500)}::uuid, 'منتج', 'new_with_tags', 'active', 'وصف'),
      (${u(2)}::uuid, ${STORE}::uuid, ${u(500)}::uuid, 'مسودة', 'new_with_tags', 'draft', null)`.execute(t.db);
    await sql`insert into skus (id, product_id, store_id, seller_sku, list_price_amount, size_label) values
      (${u(11)}::uuid, ${u(1)}::uuid, ${STORE}::uuid, 'S-1', 100000, 'M'),
      (${u(12)}::uuid, ${u(1)}::uuid, ${STORE}::uuid, 'S-2', 100000, 'L'),
      (${u(21)}::uuid, ${u(2)}::uuid, ${STORE}::uuid, 'S-3', 100000, 'M')`.execute(t.db);
    await sql`set session_replication_role = origin`.execute(t.db);
  }, 120_000);
  afterAll(async () => {
    await t.app.close();
  });

  it("the directory resolves a product's SKUs and active flag; unknown and draft products expose nothing", async () => {
    expect(await svc.evidenceForProduct(u(404))).toBeNull();
    expect(await svc.evidenceForProduct("not-a-uuid")).toBeNull();
    // Draft product: not public.
    expect(await svc.evidenceForProduct(u(2))).toBeNull();
    const none = await svc.evidenceForProduct(u(1));
    // Active product with no price history: no SKU carries evidence, so no claim can be shown.
    expect(none?.skus).toEqual([]);
  });

  it("records price changes in the real ledger and claims only from internal history (external evidence is shadow-only)", async () => {
    const now = Date.now();
    await svc.recordPriceChange({ skuId: u(11), storeId: STORE, priceAmount: 100_000n, validFromMs: now - 40 * DAY, source: "seller", actorId: u(1), idempotencyKey: "p1" });
    const cut = await svc.recordPriceChange({ skuId: u(11), storeId: STORE, priceAmount: 80_000n, validFromMs: now - DAY, source: "seller", actorId: u(1), idempotencyKey: "p2" });
    expect(cut.result.status).toBe("verified_discount");
    const view = await svc.evidenceForProduct(u(1));
    const sku = view?.skus.find((s) => s.skuId === u(11));
    expect(sku?.result.status).toBe("verified_discount");
    expect(sku?.lowest30dAmount).toBe(80_000n);
    // The other SKU has no history: no strike-through, ever.
    expect(view?.skus.find((s) => s.skuId === u(12))).toBeUndefined();
    const rows = await sql<{ n: string }>`select count(*)::text as n from price_events where sku_id = ${u(11)}::uuid`.execute(t.db);
    expect(rows.rows[0]?.n).toBe("2");
  });

  it("production forRoot without persistence still refuses (no fixtures in production)", () => {
    expect(() => PriceIntegrityModule.forRoot(loadConfig({ ...PROD_ENV }))).toThrow(NoProductionAdaptersError);
  });
});
