import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { Actor } from "@outlet/policy";
import { createTestDatabaseUpTo } from "@outlet/db";
import { createPgliteDatabase, type PgliteInstance } from "./platform/db";
import {
  IDEM,
  STORE_A as RET_STORE_A,
  STORE_B as RET_STORE_B,
  TOKENS as RET_TOKENS,
  U as RU,
  bearer as retBearer,
  createReturnsHarness,
  line as retLine,
} from "./modules/returns/test/returns-harness";
import { KyselyReturnRepository, type ReturnsDb } from "./modules/returns/adapters/kysely-store";
import { money } from "./modules/search/domain/bridge";
import { KyselyOrderRepository, type OrdersDb } from "./modules/orders/adapters/kysely-store";
import { ORDER_A, STAFF_A, STORE_A as ORD_STORE_A, TestClock, sellerScope } from "./modules/orders/test/fixtures";
import { SearchProducts } from "./modules/search/application/search";
import {
  FakeProductFacts,
  InMemorySearchEventPublisher,
  InMemorySearchIndex,
  StaticKillSwitch,
  StaticShopperScope,
} from "./modules/search/adapters/in-memory";
import { TypesenseSearchPort } from "./modules/search/adapters/typesense";
import { doc, P, S, T0 as SEARCH_T0 } from "./modules/search/test/index-contract";
import { storeSummary } from "./modules/cart";
import type { ProductFacts } from "./modules/search/domain/ports";

type Closable = { destroy(): Promise<void> };
const open: Closable[] = [];
afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

const MULTI_SCOPES = ["seller:read", "seller:write"] as const;

describe("wave 3 adversarial: confirmed defects", () => {
  // ADV-W3-1 BOLA by "first store": GET /v1/seller/returns authorizes the actor's FIRST brand grant
  // only, then lists returns for EVERY brand grant. A user who is `catalog` (no return read right)
  // in store A and `owner` of store B (listed first) reads store A's returns.
  it("the seller return queue lists only stores where the actor holds a return-read role", async () => {
    const h = await createReturnsHarness();
    try {
      h.lines.add(retLine(1, { storeId: RET_STORE_A }));
      const created = await h
        .http()
        .post(`/v1/orders/lines/${retLine(1).orderLineId}/returns`)
        .set(retBearer(RET_TOKENS.shopper1))
        .set({ "Idempotency-Key": IDEM(1) })
        .send({ qty: 1, reason: "changed_mind", resolution: "refund", method: "pickup" });
      expect(created.status).toBeLessThan(300);
      const returnId = created.body.id as string;

      const actor: Actor = {
        id: RU(777),
        status: "active",
        assurance: "basic",
        grants: [
          { kind: "brand", storeId: RET_STORE_B, role: "owner" },
          { kind: "brand", storeId: RET_STORE_A, role: "catalog" },
        ],
        tokenScopes: [...MULTI_SCOPES],
      };
      h.tokens.add("token-multi-store-staff-7777", { actor, aud: "seller_api" });

      // control: the catalog role alone is refused for store A
      const direct = await h.http().get("/v1/seller/returns").set(retBearer(RET_TOKENS.catalogA));
      expect(direct.status).toBe(403);

      const res = await h.http().get("/v1/seller/returns").set(retBearer("token-multi-store-staff-7777"));
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(returnId);
    } finally {
      await h.close();
    }
  });

  // ADV-W3-2 the idempotency key hash covers the route TEMPLATE, not the concrete path, so one key
  // reused on a different order line replays the first line's response and the second request
  // never runs (spec A2.5: same key + different request must be 422).
  it("one Idempotency-Key reused on a different order line is not replayed as success", async () => {
    const h = await createReturnsHarness();
    try {
      h.lines.add(retLine(1));
      h.lines.add(retLine(2));
      const body = { qty: 1, reason: "changed_mind", resolution: "refund", method: "pickup" };
      const key = { "Idempotency-Key": IDEM(42) };
      const first = await h.http().post(`/v1/orders/lines/${retLine(1).orderLineId}/returns`).set(retBearer(RET_TOKENS.shopper1)).set(key).send(body);
      expect(first.status).toBeLessThan(300);
      const second = await h.http().post(`/v1/orders/lines/${retLine(2).orderLineId}/returns`).set(retBearer(RET_TOKENS.shopper1)).set(key).send(body);
      const handledForLine2 = second.status === 422 || second.body.order_line_id === retLine(2).orderLineId;
      expect(handledForLine2).toBe(true);
    } finally {
      await h.close();
    }
  });

  // ADV-W3-3 cursor tampering: 36 hyphens satisfy the cursor regex and reach `$1::uuid` in
  // Postgres (22P02), so a forged cursor is a 500 instead of a 400.
  it("a forged returns cursor with a non-uuid id does not crash the Postgres adapter", async () => {
    const sql = readFileSync(
      fileURLToPath(new URL("../../../packages/db/migrations/0020_returns.sql", import.meta.url)),
      "utf8",
    );
    const raw = await createTestDatabaseUpTo(11);
    await raw.exec(sql);
    const db: ReturnsDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
    open.push(db);
    const repo = new KyselyReturnRepository(db);
    const cursor = Buffer.from(`1:${"-".repeat(36)}`, "utf8").toString("base64url");
    await expect(repo.listForUser(RU(1), cursor, 10)).resolves.toBeDefined();
  });

  // ADV-W3-4 cursor tampering: the seller-orders cursor schema has no upper bound on `c`, and
  // `new Date(c).toISOString()` throws RangeError above 8.64e15 ms (a safe integer).
  it("a seller-orders cursor with an out-of-range timestamp does not throw", async () => {
    const raw = await createTestDatabaseUpTo(19);
    const db: OrdersDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
    open.push(db);
    const repo = new KyselyOrderRepository(db, new TestClock());
    await expect(
      repo.listForStores({
        scope: sellerScope(STAFF_A, ORD_STORE_A),
        storeIds: [ORD_STORE_A],
        after: { createdAtMs: 9_000_000_000_000_000, id: ORDER_A },
        limit: 10,
      }),
    ).resolves.toBeDefined();
  });

  // ADV-W3-5 sponsored cap ("at most 2 in the top 10") is applied only to the first page, so with
  // a small page size the second page is uncapped and the first 10 shown results exceed the cap.
  it("never shows more than 2 sponsored results in the first 10 across pages", async () => {
    const index = new InMemorySearchIndex();
    const facts = new FakeProductFacts();
    const uc = new SearchProducts({
      primary: new TypesenseSearchPort(null),
      fallback: index,
      killSwitch: new StaticKillSwitch(false),
      facts,
      scope: new StaticShopperScope(),
      events: new InMemorySearchEventPublisher(),
      clock: { nowMs: () => SEARCH_T0 },
    });
    const mkFacts = (n: number, sponsored: boolean): ProductFacts => ({
      productId: P(n),
      title: { ar: `منتج ${n}` },
      store: storeSummary(S(1)),
      unitPrice: money(100_000n),
      badge: "none",
      referencePrice: null,
      discountPct: null,
      condition: "new_with_tags",
      sponsored,
      purchasable: true,
    });
    for (let n = 1; n <= 30; n += 1) {
      const sponsored = n <= 10;
      await index.upsert(doc(n, { searchText: "dress", sponsored }));
      facts.set(mkFacts(n, sponsored));
    }
    const USER = "00000000-0000-4000-8000-000000000001";
    const shown: { sponsored: boolean }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 6 && shown.length < 10; page += 1) {
      const r = await uc.execute({ userId: USER, q: "dress", filter: {}, limit: 5, ...(cursor !== undefined ? { cursor } : {}) });
      shown.push(...r.items.map((i) => ({ sponsored: i.sponsored })));
      if (r.nextCursor === null) break;
      cursor = r.nextCursor;
    }
    expect(shown.slice(0, 10).filter((i) => i.sponsored).length).toBeLessThanOrEqual(2);
  });
});
