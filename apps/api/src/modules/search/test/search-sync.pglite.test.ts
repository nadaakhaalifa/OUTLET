import type { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { CatalogIndexSource } from "../adapters/catalog-index-source";
import { PostgresFtsSearchPort, type SearchDb } from "../adapters/postgres-fts";
import { SearchSyncConsumer } from "../application/sync";
import { P, req } from "./index-contract";
import { createSearchDatabase } from "./pg-fixture";
import { BRAND, FakeSnapshots, listed, unlisted } from "./snapshot-fixtures";

const open: SearchDb[] = [];
afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describe("search sync into Postgres (PGlite)", () => {
  it("writes brand_id, replays idempotently, and deletes when the product leaves active", async () => {
    const raw: PGlite = await createSearchDatabase({ trigram: false });
    const db: SearchDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
    open.push(db);
    const port = await PostgresFtsSearchPort.create(db);
    const snaps = new FakeSnapshots();
    const consumer = new SearchSyncConsumer({
      source: new CatalogIndexSource(snaps),
      writer: PostgresFtsSearchPort.writer(db),
      metrics: { record: () => undefined },
      clock: { nowMs: () => Date.now() },
    });
    const ev = (type: string, version: number) => ({ messageId: "00000000-0000-4000-8000-000000000001", type, payload: { productId: P(1), version } });
    const hits = async (): Promise<string[]> => (await port.search(req({ filter: { brandIds: [BRAND] } }))).hits.map((h) => h.productId);

    snaps.set(listed(1));
    await consumer.handle(ev("product.created", 1));
    await consumer.handle(ev("product.created", 1));
    expect(await hits()).toEqual([P(1)]);

    snaps.set(unlisted(1, 2));
    await consumer.handle(ev("product.status_changed", 2));
    expect(await hits()).toEqual([]);
    expect((await port.search(req())).total).toBe(0);
  });
});
