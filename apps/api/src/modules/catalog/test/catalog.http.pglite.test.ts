import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SEED } from "../adapters/in-memory";
import { PRINCIPALS, STORE_A, bearer, createCatalogHarness, idemKey, type CatalogHarness } from "./harness";
import { createCatalogPglite, type CatalogPglite } from "./pglite-fixture";

const UP_IMG = "0192f3a4-5b6c-7d8e-9f01-0000000a0101";

let pg: CatalogPglite;
let h: CatalogHarness;

beforeAll(async () => {
  pg = await createCatalogPglite();
  // The seller's tenant must exist for the product FK; the harness fixtures supply store profiles.
  await pg.raw.query(
    `INSERT INTO stores (id, seller_id, kind, slug, name_ar, status, seller_kyc_state) VALUES ($1,$2,'local','pg-store-a','متجر','ACTIVE','APPROVED')`,
    [STORE_A, "0192f3a4-5b6c-7d8e-9f01-000000009901"],
  );
  pg.setSession({ userId: PRINCIPALS.ownerA.actor.id, role: "seller", storeIds: [STORE_A] });
  h = await createCatalogHarness({ runner: pg.runner, session: pg.session });
  h.fixtures.uploads.add(STORE_A, UP_IMG);
});
afterAll(async () => {
  await h.close();
  await pg.close();
});

describe("catalog module over Kysely + PGlite (RLS as app_user)", () => {
  it("creates and publishes a product, appending outbox events in the same transaction", async () => {
    const created = await h
      .http()
      .post("/v1/seller/products")
      .set(bearer(PRINCIPALS.ownerA))
      .set("Idempotency-Key", idemKey())
      .send({
        title: { ar: "فستان كتان أبيض" },
        description: { ar: "فستان صيفي خفيف" },
        category_id: SEED.categoryDresses,
        condition: "new_with_tags",
        image_upload_ids: [UP_IMG],
        skus: [{ size_label: "M", color: "White", price: { amount: "129900", currency: "EGP" }, initial_stock: 2 }],
      });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    const got = await h.http().get(`/v1/seller/products/${id}`).set(bearer(PRINCIPALS.ownerA));
    expect(got.status).toBe(200);
    const published = await h
      .http()
      .patch(`/v1/seller/products/${id}`)
      .set(bearer(PRINCIPALS.ownerA))
      .set("If-Match", String(got.headers["etag"]))
      .send({ status: "active" });
    expect(published.status).toBe(200);
    expect(published.body.status).toBe("active");

    const rows = await pg.raw.query<{ event_type: string; payload: { store_id: string; product_id: string } }>(
      `SELECT event_type, payload FROM outbox_events WHERE aggregate_id = $1 ORDER BY occurred_at, id`,
      [id],
    );
    const types = rows.rows.map((r) => r.event_type);
    expect(types).toContain("product.created");
    expect(types).toContain("product.updated");
    expect(types).toContain("product.status_changed");
    expect(rows.rows.every((r) => r.payload.store_id === STORE_A && r.payload.product_id === id)).toBe(true);
  });
});
