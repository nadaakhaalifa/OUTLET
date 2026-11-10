import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyDbContext } from "../src/index.js";
import type { DbContext, WorkerJob } from "../src/index.js";
import type { SqlClient } from "../src/sql.js";
import { asRole, createTestClient } from "../src/testing.js";

// Migration 0038: search_documents is written only by the `search.sync` job (market-pinned), read by outlet_app in user/store contexts (market-pinned);
// price_claims is readable (not writable) by `search.sync`, market-pinned. Every other job, market and role gets nothing.

const worker = (job: WorkerJob, marketId = "EG"): DbContext => ({ kind: "worker", marketId, job });
let c: SqlClient;
let close: () => Promise<void>;
const P_EG = randomUUID();
const P_AE = randomUUID();
const SKU = randomUUID();

const asWorker = <T>(ctx: DbContext, fn: (q: (sql: string, p?: unknown[]) => Promise<number>) => Promise<T>): Promise<T> =>
  asRole(c, "outlet_worker", async (tx) => {
    await applyDbContext(tx, ctx);
    return fn(async (sql, p) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) q`, p)).rows[0]?.n ?? -1);
  });
const ins = (id: string, market: string): string =>
  `INSERT INTO search_documents (product_id, market_id, store_ref, world, title_ar, search_text, tsv, price_minor, currency, condition_grade, updated_at, seq)
   VALUES ('${id}','${market}','${randomUUID()}','local','x','x',to_tsvector('simple','x'),100,'EGP','new_with_tags',now(),1)`;

beforeAll(async () => {
  ({ client: c, close } = await createTestClient());
  await c.query(ins(P_EG, "EG"));
  await c.query(ins(P_AE, "AE"));
  for (const m of ["EG", "AE"]) {
    const seller = randomUUID();
    const store = randomUUID();
    await c.query("INSERT INTO sellers (id, home_market_id, market_id, legal_type, status) VALUES ($1,$2,$2,'company','draft')", [seller, m]);
    await c.query("INSERT INTO stores (id, seller_id, market_id, slug, display_name_ar, kind, ships_from_country) VALUES ($1,$2,$3,$4,'متجر','local','EG')", [store, seller, m, `s-${m.toLowerCase()}`]);
    await c.query(
      `INSERT INTO price_claims (id, sku_id, store_id, market_id, price_minor, vrp_minor, currency, reference_class, discount_bp, claim_type, display_allowed, trust_score, status, rule_version, reason, scored_at)
       VALUES ($1,$2,$3,$4,800,1000,'EGP','internal',2000,'verified_discount',true,90,'active','v1','test', now())`,
      [randomUUID(), SKU, store, m],
    );
  }
});
afterAll(async () => close());

describe("search_documents (migration 0038)", () => {
  it("search.sync reads and writes its own market only", async () => {
    expect(await asWorker(worker("search.sync"), (q) => q("SELECT 1 FROM search_documents"))).toBe(1);
    expect(await asWorker(worker("search.sync", "AE"), (q) => q("SELECT 1 FROM search_documents"))).toBe(1);
    expect(await asWorker(worker("search.sync", "ZZ"), (q) => q("SELECT 1 FROM search_documents"))).toBe(0);
    await asRole(c, "outlet_worker", async (tx) => {
      await applyDbContext(tx, worker("search.sync"));
      expect((await tx.query("UPDATE search_documents SET in_stock = false RETURNING 1")).rows).toHaveLength(1); // AE row untouched
      await tx.query(ins(randomUUID(), "EG"));
      await expect(tx.query(ins(randomUUID(), "AE"))).rejects.toThrow(/row-level security/);
    });
  });
  it("search.sync cannot delete (no grant)", async () => {
    await asRole(c, "outlet_worker", async (tx) => {
      await applyDbContext(tx, worker("search.sync"));
      await expect(tx.query("DELETE FROM search_documents")).rejects.toThrow(/permission denied/);
    });
  });
  it("every other worker job sees and changes nothing", async () => {
    for (const job of ["outbox.relay", "ops.attention", "reporting.rollup", "admin.dashboard", "pricing.channels", "notifications.dispatch", "seller.kyc"] as const) {
      expect(await asWorker(worker(job), (q) => q("SELECT 1 FROM search_documents"))).toBe(0);
      await asRole(c, "outlet_worker", async (tx) => {
        await applyDbContext(tx, worker(job));
        expect((await tx.query("UPDATE search_documents SET in_stock = true RETURNING 1")).rows).toHaveLength(0);
        await expect(tx.query(ins(randomUUID(), "EG"))).rejects.toThrow(/row-level security/);
      });
    }
  });
  it("outlet_app reads its market in user and store contexts but cannot write; an auth context and outlet_auth read nothing", async () => {
    for (const ctx of [{ kind: "user", marketId: "EG" }, { kind: "store", marketId: "EG", storeId: randomUUID() }] as const) {
      await asRole(c, "outlet_app", async (tx) => {
        await applyDbContext(tx, ctx);
        expect((await tx.query("SELECT 1 FROM search_documents")).rows.length).toBeGreaterThanOrEqual(1);
        expect((await tx.query("SELECT 1 FROM search_documents WHERE market_id = 'AE'")).rows).toHaveLength(0);
        await expect(tx.query("UPDATE search_documents SET in_stock = true")).rejects.toThrow(/permission denied/);
      });
    }
    await asRole(c, "outlet_app", async (tx) => {
      await applyDbContext(tx, { kind: "user", marketId: "ZZ" });
      expect((await tx.query("SELECT 1 FROM search_documents")).rows).toHaveLength(0);
    });
    await expect(asRole(c, "outlet_auth", (tx) => tx.query("SELECT 1 FROM search_documents"))).rejects.toThrow(/permission denied/);
  });
});

describe("price_claims read for search.sync (migration 0038)", () => {
  it("search.sync reads claims of its own market only and cannot write them", async () => {
    expect(await asWorker(worker("search.sync"), (q) => q("SELECT 1 FROM price_claims"))).toBe(1);
    expect(await asWorker(worker("search.sync", "AE"), (q) => q("SELECT 1 FROM price_claims"))).toBe(1);
    expect(await asWorker(worker("search.sync", "ZZ"), (q) => q("SELECT 1 FROM price_claims"))).toBe(0);
    await asRole(c, "outlet_worker", async (tx) => {
      await applyDbContext(tx, worker("search.sync"));
      expect((await tx.query("UPDATE price_claims SET display_allowed = false RETURNING 1")).rows).toHaveLength(0);
    });
  });
  it("jobs without a claims policy read none", async () => {
    for (const job of ["notifications.dispatch", "ops.attention", "outbox.relay"] as const) expect(await asWorker(worker(job), (q) => q("SELECT 1 FROM price_claims"))).toBe(0);
  });
});
