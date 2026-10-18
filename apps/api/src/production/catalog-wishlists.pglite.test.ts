import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { createTestDatabaseUpTo } from "@outlet/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureApp } from "../app.setup";
import { loadConfig } from "../config/env";
import { createPersistence } from "../persistence";
import { PlatformModule, createIdGenerator, nodeCsprng } from "../platform";
import { createPgliteDatabase, type PgliteInstance } from "../platform/db";
import { CatalogModule, MAX_SIGNED_URL_TTL_SECONDS, MissingCatalogPortsError, SignedUrlMediaResolver, SEED } from "../modules/catalog";
import { PRINCIPALS, STORE_A, TestAuthModule, TestClock, bearer, idemKey } from "../modules/catalog/test/harness";
import { MissingWishlistPortsError, WishlistsModule } from "../modules/wishlists";
import { composeCatalogAndWishlists } from "./catalog-wiring";
import { unconfigured } from "./unconfigured";
import type { CatalogObjectStore } from "../modules/catalog";
import { SEED_BRANDS, SEED_CATEGORIES } from "../modules/catalog/adapters/in-memory";
import type { INestApplication } from "@nestjs/common";
import type { Kysely } from "kysely";
import { bootProduction } from "./test/test-support";

const KEY = "d".repeat(32);
const BUYER = PRINCIPALS.buyer.actor.id;
const owner = PRINCIPALS.ownerA;
const egp = (n: string) => ({ amount: n, currency: "EGP" });

let app: INestApplication;
let db: Kysely<Record<string, never>>;
let raw: Awaited<ReturnType<typeof createTestDatabaseUpTo>>;
let prices: ReturnType<typeof composeCatalogAndWishlists>["prices"];
const UP_IMG = "0192f3a4-5b6c-7d8e-9f01-0000000a0101";
/** Stands in for a configured S3 adapter. Disabled it is the production default: Unconfigured (503). */
const objects: { enabled: boolean; store: CatalogObjectStore } = {
  enabled: true,
  store: {
    async ownedBy(storeId, ids) {
      return new Set(ids.filter((i) => storeId === STORE_A && i === UP_IMG));
    },
    async readText() {
      return null;
    },
  },
};
const unconfiguredObjects = unconfigured<CatalogObjectStore>("object.store");
const objectStore: CatalogObjectStore = {
  ownedBy: (a, b) => (objects.enabled ? objects.store : unconfiguredObjects).ownedBy(a, b),
  readText: (a, b) => (objects.enabled ? objects.store : unconfiguredObjects).readText(a, b),
};
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  raw = await createTestDatabaseUpTo(9999);
  db = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  const config = loadConfig({ NODE_ENV: "test", SIZE_DEMAND_PSEUDONYM_KEY: KEY });
  const pg = createPersistence(config, db);
  const wiring = composeCatalogAndWishlists(config, pg, { objects: objectStore, media: { baseUrl: "https://media.example.test/u", signingKey: "k".repeat(32) } });
  prices = wiring.prices;

  for (const c of SEED_CATEGORIES) {
    await raw.query(
      `INSERT INTO categories (id, slug, name_ar, name_en, product_type, return_class, requires_size_chart, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [c.id, c.slug, c.nameAr, c.nameEn ?? null, c.productType, c.returnClass, c.requiresSizeChart, c.active],
    );
  }
  for (const b of SEED_BRANDS) await raw.query(`INSERT INTO brands (id, slug, name_ar, name_en) VALUES ($1,$2,$3,$4)`, [b.id, b.slug, b.nameAr, b.nameEn ?? null]);
  await raw.query(
    `INSERT INTO stores (id, seller_id, kind, slug, name_ar, status, seller_kyc_state) VALUES ($1,$2,'local','prod-store-a','متجر','ACTIVE','APPROVED')`,
    [STORE_A, "0192f3a4-5b6c-7d8e-9f01-000000009901"],
  );
  await raw.query(
    `INSERT INTO store_legal_identity_public (store_id, legal_name_ar, commercial_register_no, tax_card_no, governorate) VALUES ($1,'شركة الاختبار','CR-77','TC-88','Cairo')`,
    [STORE_A],
  );
  await raw.query(`INSERT INTO users (id, status) VALUES ($1,'active')`, [BUYER]);

  const clock = new TestClock();
  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids: createIdGenerator(clock, nodeCsprng) }),
      TestAuthModule.register(),
      wiring.catalog,
      wiring.wishlists,
    ],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
}, 120_000);

afterAll(async () => {
  await app.close();
});

async function createAndPublish(skus: { size: string; stock: number; price: string }[], extra: Record<string, unknown> = {}): Promise<{ id: string; skuIds: string[]; bySize: Record<string, string> }> {
  const created = await http()
    .post("/v1/seller/products")
    .set(bearer(owner))
    .set("Idempotency-Key", idemKey())
    .send({
      title: { ar: "فستان كتان أبيض", en: "White linen dress" },
      description: { ar: "فستان صيفي خفيف", en: "Light summer dress" },
      category_id: SEED.categoryDresses,
      condition: "new_with_tags",
      image_upload_ids: [UP_IMG],
      skus: skus.map((s) => ({ size_label: s.size, color: "White", price: egp(s.price), initial_stock: s.stock })),
      ...extra,
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.id as string;
  const got = await http().get(`/v1/seller/products/${id}`).set(bearer(owner));
  const published = await http().patch(`/v1/seller/products/${id}`).set(bearer(owner)).set("If-Match", String(got.headers["etag"])).send({ status: "active" });
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  const list = got.body.skus as { id: string; size_label: string }[];
  return { id, skuIds: list.map((s) => s.id), bySize: Object.fromEntries(list.map((s) => [s.size_label, s.id])) };
}

describe("catalog on real Postgres stores: create -> publish -> public read model", () => {
  it("shows stock only when <= 5, from the inventory module, and no reference price without verified evidence", async () => {
    const p = await createAndPublish([
      { size: "M", stock: 3, price: "129900" },
      { size: "L", stock: 8, price: "129900" },
    ]);
    const levels = await raw.query<{ on_hand: number }>(`SELECT on_hand FROM inventory_levels WHERE sku_id = $1`, [p.bySize["M"]]);
    expect(levels.rows[0]?.on_hand).toBe(3);

    const read = await http().get(`/v1/products/${p.id}`).set(bearer(PRINCIPALS.buyer));
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const bySku = new Map((read.body.skus as { id: string; units_left: number | null; available: boolean }[]).map((x) => [x.id, x]));
    const m = bySku.get(p.bySize["M"] ?? "");
    const l = bySku.get(p.bySize["L"] ?? "");
    expect(m?.units_left).toBe(3);
    expect(l?.units_left).toBeNull();
    expect(l?.available).toBe(true);
    for (const s of read.body.skus as { price: { reference_price: unknown; discount_pct: unknown; badge: string } }[]) {
      expect(s.price).toMatchObject({ reference_price: null, discount_pct: null, badge: "none" });
    }
    expect(read.body.price).toMatchObject({ reference_price: null, discount_pct: null });
    // Seller legal identity comes from the stores module projection (B5).
    expect(read.body.seller_legal_identity).toEqual({ legal_name: "شركة الاختبار", commercial_register_no: "CR-77", tax_card_no: "TC-88", governorate: "Cairo" });
  });

  it("a reference price appears only when the price-integrity reader supplies a verified block", async () => {
    const p = await createAndPublish([{ size: "S", stock: 2, price: "100000" }]);
    prices.bind({
      async blocks(skuIds) {
        return new Map(skuIds.map((id) => [id, { badge: "verified_discount" as const, referencePrice: { amount: 150_000n, currency: "EGP" as const }, discountPct: 33, claimId: "claim-1" }]));
      },
    });
    try {
      const read = await http().get(`/v1/products/${p.id}`).set(bearer(PRINCIPALS.buyer));
      expect(read.body.skus[0].price).toMatchObject({ badge: "verified_discount", discount_pct: 33, reference_price: egp("150000") });
      // A claim with a reference but no verified badge is coerced to a plain price.
      prices.bind({
        async blocks(skuIds) {
          return new Map(skuIds.map((id) => [id, { badge: "none" as const, referencePrice: { amount: 150_000n, currency: "EGP" as const }, discountPct: 33, claimId: "x" }]));
        },
      });
      const plain = await http().get(`/v1/products/${p.id}`).set(bearer(PRINCIPALS.buyer));
      expect(plain.body.skus[0].price).toMatchObject({ badge: "none", discount_pct: null, reference_price: null });
    } finally {
      prices.bind({ blocks: async () => new Map() });
    }
  });

  it("upload-dependent writes answer 503 provider_not_configured; reads of existing products keep working", async () => {
    const existing = await createAndPublish([{ size: "M", stock: 2, price: "50000" }]);
    objects.enabled = false;
    try {
      const read = await http().get(`/v1/products/${existing.id}`).set(bearer(PRINCIPALS.buyer));
      expect(read.status).toBe(200);
      expect(read.body.images[0].url).toMatch(/^https:\/\/media\.example\.test\/u\/.+\?exp=\d+&sig=/);
      await uploadsRefused();
    } finally {
      objects.enabled = true;
    }
  });

  const uploadsRefused = async (): Promise<void> => {
    const res = await http()
      .post("/v1/seller/products")
      .set(bearer(owner))
      .set("Idempotency-Key", idemKey())
      .send({
        title: { ar: "قميص", en: "Shirt" },
        description: { ar: "قميص قطن", en: "Cotton shirt" },
        category_id: SEED.categoryDresses,
        condition: "new_with_tags",
        image_upload_ids: ["0192f3a4-5b6c-7d8e-9f01-0000000a0101"],
        skus: [{ size_label: "M", price: egp("50000"), initial_stock: 1 }],
      });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("provider_not_configured");
    const imp = await http().post("/v1/seller/catalog/imports").set(bearer(owner)).set("Idempotency-Key", idemKey()).send({ upload_id: "0192f3a4-5b6c-7d8e-9f01-0000000a0102", dry_run: true });
    expect(imp.status).toBe(503);
  };

  it("appends catalog events to the outbox in the same transaction as the writes", async () => {
    const p = await createAndPublish([{ size: "XL", stock: 1, price: "70000" }]);
    const rows = await raw.query<{ event_type: string }>(`SELECT event_type FROM outbox_events WHERE aggregate_id = $1 ORDER BY occurred_at, id`, [p.id]);
    expect(rows.rows.map((r) => r.event_type)).toEqual(expect.arrayContaining(["product.created", "product.updated", "product.status_changed"]));
  });
});

describe("wishlists on real Postgres stores: save with intent -> shared link -> revoke", () => {
  it("reads product facts through the catalog, shares by an unguessable link, and revokes", async () => {
    const p = await createAndPublish([{ size: "M", stock: 4, price: "89900" }]);
    const created = await http().post("/v1/me/wishlists").set(bearer(PRINCIPALS.buyer)).set("Idempotency-Key", idemKey()).send({ intent: "treat", title: "هدية لنفسي" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const listId = created.body.id as string;

    const added = await http().post(`/v1/wishlists/${listId}/items`).set(bearer(PRINCIPALS.buyer)).set("Idempotency-Key", idemKey()).send({ product_id: p.id, sku_pref: p.skuIds[0] });
    expect(added.status, JSON.stringify(added.body)).toBe(201);

    const detail = await http().get(`/v1/me/wishlists/${listId}`).set(bearer(PRINCIPALS.buyer));
    expect(detail.body.items).toHaveLength(1);
    expect(detail.body.items[0]).toMatchObject({ state: "active" });
    expect(detail.body.items[0].product).toMatchObject({ id: p.id });

    const shared = await http().post(`/v1/me/wishlists/${listId}/share`).set(bearer(PRINCIPALS.buyer)).send({});
    expect(shared.status, JSON.stringify(shared.body)).toBe(201);
    const token = String(shared.body.url).split("/").pop() ?? "";
    expect(token.length).toBeGreaterThanOrEqual(22);
    const pub = await http().get(`/v1/shared/wishlists/${token}`);
    expect(pub.status).toBe(200);
    expect(pub.body.items).toHaveLength(1);
    expect(JSON.stringify(pub.body)).not.toContain(BUYER);

    const revoked = await http().delete(`/v1/me/wishlists/${listId}/share`).set(bearer(PRINCIPALS.buyer));
    expect(revoked.status).toBe(204);
    expect((await http().get(`/v1/shared/wishlists/${token}`)).status).toBe(404);

    const types = await raw.query<{ event_type: string }>(`SELECT event_type FROM outbox_events WHERE aggregate_id = $1 ORDER BY occurred_at, id`, [listId]);
    expect(types.rows.map((r) => r.event_type)).toEqual(["wishlist.shared", "wishlist.share_revoked"]);
  });

  it("an unlisted product shows as a ghost, and a store that is not shopper-visible hides the product", async () => {
    const p = await createAndPublish([{ size: "M", stock: 4, price: "89900" }]);
    const created = await http().post("/v1/me/wishlists").set(bearer(PRINCIPALS.buyer)).set("Idempotency-Key", idemKey()).send({ intent: "need", title: "x" });
    const listId = created.body.id as string;
    await http().post(`/v1/wishlists/${listId}/items`).set(bearer(PRINCIPALS.buyer)).set("Idempotency-Key", idemKey()).send({ product_id: p.id });
    await raw.query(`UPDATE stores SET status = 'SUSPENDED' WHERE id = $1`, [STORE_A]);
    try {
      expect((await http().get(`/v1/products/${p.id}`).set(bearer(PRINCIPALS.buyer))).status).toBe(404);
      const detail = await http().get(`/v1/me/wishlists/${listId}`).set(bearer(PRINCIPALS.buyer));
      expect(detail.body.items[0].state).toBe("delisted_ghost");
    } finally {
      await raw.query(`UPDATE stores SET status = 'ACTIVE' WHERE id = $1`, [STORE_A]);
    }
  });
});

describe("production boot guards", () => {
  const prod = loadConfig({
    NODE_ENV: "production",
    DEV_FIXTURES: "false",
    DATABASE_URL: "postgres://app@db.invalid/outlet",
    SIZE_DEMAND_PSEUDONYM_KEY: KEY,
    OTP_PEPPER: "p".repeat(32),
    IP_HASH_KEY: "k".repeat(32),
    AGE_BLOCK_KEY: "a".repeat(32),
  });

  it("catalog reads persistence first, then names every missing external port", () => {
    const pg = createPersistence(prod, db);
    expect(() => CatalogModule.forRoot(prod, undefined, undefined)).toThrow();
    try {
      CatalogModule.forRoot(prod, undefined, pg.catalog);
      throw new Error("expected MissingCatalogPortsError");
    } catch (e) {
      expect(e).toBeInstanceOf(MissingCatalogPortsError);
      expect((e as MissingCatalogPortsError).missing).toEqual(["stock", "stockSeeder", "prices", "stores", "sizeCharts", "uploads", "media"]);
    }
  });

  it("wishlists throws MissingWishlistPortsError for the catalog and owner ports only", () => {
    const pg = createPersistence(prod, db);
    try {
      WishlistsModule.forRoot(prod, { repository: pg.wishlists.repository });
      throw new Error("expected MissingWishlistPortsError");
    } catch (e) {
      expect(e).toBeInstanceOf(MissingWishlistPortsError);
      expect((e as MissingWishlistPortsError).missing).toEqual(["catalog", "owners"]);
    }
  });

  it("production composition builds both modules without any fixture", () => {
    const pg = createPersistence(prod, db);
    expect(() => composeCatalogAndWishlists(prod, pg)).not.toThrow();
  });
});

describe("signed media URLs", () => {
  it("expire within 15 minutes even if configured longer, and are absent without configuration", async () => {
    const clock = { nowMs: () => 1_800_000_000_000 };
    const r = new SignedUrlMediaResolver({ baseUrl: "https://m.test/u/", signingKey: "k".repeat(32), ttlSeconds: 86_400 }, clock);
    const url = (await r.resolve(["a"])).get("a")?.url ?? "";
    const exp = Number(new URL(url).searchParams.get("exp"));
    expect(exp - 1_800_000_000).toBe(MAX_SIGNED_URL_TTL_SECONDS);
    expect(MAX_SIGNED_URL_TTL_SECONDS).toBeLessThanOrEqual(900);
    expect((await new SignedUrlMediaResolver(null, clock).resolve(["a"])).size).toBe(0);
  });
});

describe("full production graph", () => {
  it("boots with catalog and wishlists on Postgres, the price-integrity reader bound, and answers 401 without a token", async () => {
    const booted = await bootProduction();
    try {
      expect(booted.app.get("outlet.catalogPriceBridge", { strict: false })).toBe(true);
      const server = request(booted.app.getHttpServer());
      expect((await server.get("/v1/products/0192f3a4-5b6c-7d8e-9f01-0000000a0001")).status).toBe(401);
      expect((await server.get("/v1/me/wishlists")).status).toBe(401);
      expect((await server.get("/v1/shared/wishlists/abcdefghijklmnopqrstuv")).status).toBe(404);
    } finally {
      await booted.app.close();
    }
  }, 120_000);
});
