import { afterAll, describe, expect, it, vi } from "vitest";
import { KyselyRecoStore, PgVectorIndex, type RecoDb } from "./kysely-store";
import { createDatabase, type PgliteLike } from "../test/pglite-db";
import { describeRecoStoreContract, U } from "../test/reco-contract";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const open: RecoDb[] = [];
let seq = 0;
const ids = { uuidV7: (): string => `00000000-0000-7000-8000-${String(200_000 + ++seq).padStart(12, "0")}` };

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeRecoStoreContract("kysely/pglite", async () => {
  const { pg, db } = await createDatabase();
  open.push(db);
  return {
    store: new KyselyRecoStore(db, ids),
    outboxTypes: async () =>
      (await pg.query<{ event_type: string }>(`select event_type from outbox_events order by id`)).rows.map((r) => r.event_type),
    setActiveModel: async (v) => {
      await pg.exec(`delete from ranking_models`);
      if (v !== null) await pg.query(`insert into ranking_models (version, status) values ($1,'active')`, [v]);
    },
  };
});

/**
 * pgvector is optional in PGlite (the extension ships separately and 0001 skips it when absent).
 * When the `vector` extension is not installed this suite is skipped on purpose, and the same SQL
 * is exercised by tooling/db/pg16-verify.mjs against a real Postgres 16 with pgvector (CI job).
 */
async function vectorAvailable(pg: PgliteLike): Promise<boolean> {
  try {
    const r = await pg.query<{ n: string }>(`select count(*)::text as n from pg_extension where extname = 'vector'`);
    return r.rows[0]?.n === "1";
  } catch {
    return false;
  }
}

describe("PgVectorIndex (pgvector adapter)", async () => {
  const { pg, db } = await createDatabase();
  open.push(db);
  const present = await vectorAvailable(pg);
  const run = present ? it : it.skip;

  it("reports availability honestly", () => {
    // Visible in the test report: skipped below means pgvector is absent in this PGlite build.
    expect(typeof present).toBe("boolean");
  });

  run("returns nearest neighbors by cosine similarity, excluding the anchor", async () => {
    await pg.exec(`create table if not exists product_embeddings (product_id uuid primary key, vec vector(3) not null)`);
    await pg.query(`insert into product_embeddings values ($1,'[1,0,0]'),($2,'[0.9,0.1,0]'),($3,'[0,1,0]')`, [U(1), U(2), U(3)]);
    const nn = await new PgVectorIndex(db).nearest(U(1), 2);
    expect(nn.map((n) => n.productId)).toEqual([U(2), U(3)]);
    expect(nn[0]!.score).toBeGreaterThan(nn[1]!.score);
  });

  it("throws (so callers degrade to rules) when the embeddings table is missing", async () => {
    if (present) return;
    await expect(new PgVectorIndex(db).nearest(U(1), 2)).rejects.toThrow();
  });
});
