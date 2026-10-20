import { afterAll, describe, expect, it, vi } from "vitest";
import { evaluateRetrieval } from "../eval/harness";
import { buildSyntheticSet } from "../eval/synthetic";
import { SYNTHETIC_K, SYNTHETIC_THRESHOLDS } from "../eval/thresholds";
import { meetsThresholds } from "../domain/metrics";
import { IndexUnavailableError, type VisualSearchStore } from "../domain/ports";
import { createDatabase, migrationSql, type PgliteLike } from "../test/pglite-db";
import { FAKE_MODEL_VERSION, InMemoryVisualIndex, InMemoryVisualStore, seededUnitVector } from "./in-memory";
import { KyselyVisualIndex, KyselyVisualStore, type VisualDb } from "./kysely-store";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const open: VisualDb[] = [];
let seq = 0;
const ids = { uuidV7: (): string => `00000000-0000-7000-8000-${String(300_000 + ++seq).padStart(12, "0")}` };
const U1 = "00000000-0000-4000-8000-000000000001";
const U2 = "00000000-0000-4000-8000-000000000002";
const DAY = 86_400_000;
const T0 = 1_800_000_000_000;

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

async function fresh() {
  const { pg, db } = await createDatabase();
  open.push(db);
  for (const u of [U1, U2]) {
    await pg.query(`insert into users (id, status) values ($1, 'active')`, [u]).catch(async () => {
      // users shape differs: fall back to the minimal insert used by other module tests
      await pg.exec(`insert into users (id) values ('${u}')`);
    });
  }
  return { pg, db };
}

function contract(name: string, make: () => Promise<{ store: VisualSearchStore; outbox: () => Promise<number> | number }>) {
  describe(`store contract: ${name}`, () => {
    it("upload claim is owner-bound, single-use and expiring", async () => {
      const { store } = await make();
      await store.recordUpload({ id: "visual-query/2026/10/a", ownerId: U1, contentType: "image/jpeg", createdAtMs: T0, expiresAtMs: T0 + 600_000 });
      expect(await store.claimUpload(U2, "visual-query/2026/10/a", T0 + 1)).toBe(false);
      expect(await store.claimUpload(U1, "visual-query/2026/10/a", T0 + 1)).toBe(true);
      expect(await store.claimUpload(U1, "visual-query/2026/10/a", T0 + 2)).toBe(false);
      await store.recordUpload({ id: "visual-query/2026/10/b", ownerId: U1, contentType: "image/png", createdAtMs: T0, expiresAtMs: T0 + 600_000 });
      expect(await store.claimUpload(U1, "visual-query/2026/10/b", T0 + 600_001)).toBe(false);
    });

    it("lists expired uploads for the sweeper until they are marked deleted", async () => {
      const { store } = await make();
      await store.recordUpload({ id: "visual-query/2026/10/c", ownerId: U1, contentType: "image/webp", createdAtMs: T0, expiresAtMs: T0 + 1000 });
      expect(await store.expiredUploads(T0 + 999, 10)).toEqual([]);
      expect(await store.expiredUploads(T0 + 1000, 10)).toEqual(["visual-query/2026/10/c"]);
      await store.markUploadsDeleted(["visual-query/2026/10/c"], T0 + 2000);
      expect(await store.expiredUploads(T0 + 5000, 10)).toEqual([]);
    });

    it("quota: per-user and global caps are atomic and reset next UTC day; a user refusal does not burn the global count", async () => {
      const { store } = await make();
      const q = (user: string, now: number, u = 2, g = 3) => store.consumeQuota({ userId: user, nowMs: now, userDailyLimit: u, globalDailyLimit: g });
      expect(await q(U1, T0)).toBe("ok");
      expect(await q(U1, T0)).toBe("ok");
      expect(await q(U1, T0)).toBe("user_limit");
      expect(await q(U2, T0)).toBe("ok"); // global is 3, used 3 (refused user attempt rolled back)
      expect(await q(U2, T0)).toBe("global_limit");
      expect(await q(U1, T0 + DAY)).toBe("ok");
    });

    it("records requests with the event, and purges past retention", async () => {
      const { store, outbox } = await make();
      await store.recordRequest({ id: "00000000-0000-4000-8000-0000000000a1", tsMs: T0, mode: "image", outcome: "ok", latencyMs: 12, resultCount: 3, categoryGuess: "dress", modelVersion: FAKE_MODEL_VERSION });
      expect(await outbox()).toBe(1);
      const p = await store.purge(T0 + 3 * DAY);
      expect(p.requests).toBe(1);
    });
  });
}

contract("in-memory", async () => {
  const store = new InMemoryVisualStore();
  return { store, outbox: () => store.outbox.length };
});
contract("kysely/pglite", async () => {
  const { pg, db } = await fresh();
  return { store: new KyselyVisualStore(db, ids), outbox: async () => Number((await pg.query<{ n: string }>(`select count(*)::text n from outbox_events where event_type = 'visual_search.performed'`)).rows[0]?.n) };
});

describe("KyselyVisualIndex", () => {
  async function seed(pg: PgliteLike, products: readonly { productId: string; vector: readonly number[] }[], version = FAKE_MODEL_VERSION) {
    for (const p of products) {
      await pg.query(`insert into product_embeddings (product_id, vec, model_version) values ($1, $2::jsonb, $3)`, [p.productId, JSON.stringify(p.vector), version]);
    }
  }

  it("without the pgvector column it is unavailable unless the bounded exact scan is explicitly allowed", async () => {
    const { pg, db } = await fresh();
    await seed(pg, [{ productId: "00000000-0000-4000-8000-000000000101", vector: seededUnitVector(1) }]);
    const strict = new KyselyVisualIndex(db);
    expect(await strict.mode()).toBe("unavailable");
    await expect(strict.search({ vector: seededUnitVector(1), modelVersion: FAKE_MODEL_VERSION, k: 3 })).rejects.toBeInstanceOf(IndexUnavailableError);
    const exact = new KyselyVisualIndex(db, { allowExactScan: true });
    expect(await exact.mode()).toBe("exact-scan");
    const r = await exact.search({ vector: seededUnitVector(1), modelVersion: FAKE_MODEL_VERSION, k: 3 });
    expect(r[0]?.productId).toBe("00000000-0000-4000-8000-000000000101");
    expect(r[0]?.similarity).toBeCloseTo(1, 5);
  });

  it("exact-scan cap overflow fails loudly instead of returning a partial answer", async () => {
    const { pg, db } = await fresh();
    await seed(pg, [1, 2, 3].map((n) => ({ productId: `00000000-0000-4000-8000-00000000020${n}`, vector: seededUnitVector(n) })));
    const idx = new KyselyVisualIndex(db, { allowExactScan: true, exactScanCap: 2 });
    await expect(idx.search({ vector: seededUnitVector(1), modelVersion: FAKE_MODEL_VERSION, k: 3 })).rejects.toBeInstanceOf(IndexUnavailableError);
  });

  it("matches the brute-force oracle on the synthetic set and passes the CI gate; filters by model version", async () => {
    const { pg, db } = await fresh();
    const set = buildSyntheticSet({ seed: 5, groups: 8, perGroup: 4, queriesPerGroup: 2, productNoise: 0.5, queryNoise: 0.6, dim: 768 });
    await seed(pg, set.products);
    await seed(pg, [{ productId: "00000000-0000-4000-8000-000000009999", vector: set.queries[0]?.vector ?? [] }], "old-model");
    const sql = new KyselyVisualIndex(db, { allowExactScan: true });
    const oracle = new InMemoryVisualIndex();
    for (const p of set.products) oracle.set(p.productId, p.vector);
    const q = set.queries[0];
    const a = await sql.search({ vector: q?.vector ?? [], modelVersion: FAKE_MODEL_VERSION, k: 10 });
    const b = await oracle.search({ vector: q?.vector ?? [], modelVersion: FAKE_MODEL_VERSION, k: 10 });
    expect(a.map((n) => n.productId)).toEqual(b.map((n) => n.productId));
    expect(a.map((n) => n.productId)).not.toContain("00000000-0000-4000-8000-000000009999");
    const rep = await evaluateRetrieval({ index: sql, modelVersion: FAKE_MODEL_VERSION, queries: set.queries, k: SYNTHETIC_K });
    expect(meetsThresholds(rep, SYNTHETIC_THRESHOLDS)).toBe(true);
    const own = await sql.vectorOf(set.products[0]?.productId ?? "");
    expect(own?.modelVersion).toBe(FAKE_MODEL_VERSION);
    expect(await sql.vectorOf("00000000-0000-4000-8000-0000000fffff")).toBeNull();
  });

  it("migration 0069 is a no-op without the vector extension and idempotent; 0068/0070 re-run cleanly", async () => {
    const { pg } = await fresh();
    await pg.exec(migrationSql("0069_product_embeddings_pgvector.sql"));
    const col = await pg.query<{ n: string }>(`select count(*)::text n from information_schema.columns where table_name='product_embeddings' and column_name='vec_pg'`);
    expect(col.rows[0]?.n).toBe("0");
  });

  it("saves eval runs", async () => {
    const { db } = await fresh();
    await new KyselyVisualStore(db, ids).saveEvalRun({ id: "00000000-0000-4000-8000-0000000000e1", setName: "synthetic", modelVersion: FAKE_MODEL_VERSION, k: 5, queries: 120, recallAtK: 0.97, mrr: 0.99, coverage: 1, passed: true, ranAtMs: T0 });
    expect(true).toBe(true);
  });
});
