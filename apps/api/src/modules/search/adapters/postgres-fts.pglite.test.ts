import type { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { describeSearchIndexContract, doc, req, P } from "../test/index-contract";
import { describeSavedSearchContract } from "../test/saved-contract";
import { createSearchDatabase } from "../test/pg-fixture";
import { KyselySavedSearchRepository } from "./kysely-saved-searches";
import { PostgresFtsSearchPort, pgArray, toTsQuery, type SearchDb } from "./postgres-fts";

const open: SearchDb[] = [];

const fresh = async (trigram: boolean) => {
  const raw: PGlite = await createSearchDatabase({ trigram });
  const db: SearchDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  return { raw, db };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeSearchIndexContract("postgres fts + trigram / pglite", async () => {
  const { db } = await fresh(true);
  const port = await PostgresFtsSearchPort.create(db);
  return { port, writer: port };
});

describeSavedSearchContract("kysely / pglite", async () => {
  const { raw, db } = await fresh(false);
  return {
    repo: new KyselySavedSearchRepository(db),
    ensureUser: async (id: string) => {
      await raw.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
    },
  };
});

describe("PostgresFtsSearchPort specifics", () => {
  it("detects pg_trgm and rescues a typo with word similarity", async () => {
    const { db } = await fresh(true);
    const port = await PostgresFtsSearchPort.create(db);
    expect(port.trigramEnabled).toBe(true);
    await port.upsert(doc(1, { searchText: "Birkenstock sandal" }));
    // "birkenstok" is not a prefix of any word, so FTS is empty and trigram answers.
    const r = await port.search(req({ keywords: "birkenstok" }));
    expect(r.hits.map((h) => h.productId)).toEqual([P(1)]);
    expect(r.degraded).toBe(true);
  });

  it("works without pg_trgm (FTS only)", async () => {
    const { db } = await fresh(false);
    const port = await PostgresFtsSearchPort.create(db);
    expect(port.trigramEnabled).toBe(false);
    await port.upsert(doc(1, { searchText: "Birkenstock sandal" }));
    expect((await port.search(req({ keywords: "birkenstok" }))).hits).toEqual([]);
    expect((await port.search(req({ keywords: "birken" }))).hits).toHaveLength(1);
  });

  it("stores price as exact bigint piastres", async () => {
    const { raw, db } = await fresh(false);
    const port = await PostgresFtsSearchPort.create(db);
    await port.upsert(doc(1, { priceAmount: 9_007_199_254_740_993n }));
    const r = await raw.query<{ p: string }>("select price_amount::text as p from search_documents");
    expect(r.rows[0]?.p).toBe("9007199254740993");
    const hit = await port.search(req({ filter: { priceMin: 9_007_199_254_740_993n } }));
    expect(hit.hits).toHaveLength(1);
  });

  it("helpers never emit executable text", () => {
    expect(pgArray(['a"b', "c\\d", "}", "{x}"])).toBe('{"a\\"b","c\\\\d","}","{x}"}');
    expect(toTsQuery([["dress", "فستان"], ["x'y", "ok"]])).toBe("(dress:* | فستان:*) & (ok:*)");
    expect(toTsQuery([["!!", "&"]])).toBeNull();
  });
});
