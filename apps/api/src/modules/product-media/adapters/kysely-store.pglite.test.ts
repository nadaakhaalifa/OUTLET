import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDatabaseUpTo } from "@outlet/db";
import { afterAll, describe, expect, it } from "vitest";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { describeProductMediaStoreContract, job } from "../test/store-contract";
import { KyselyProductMediaStore, type ProductMediaDb } from "./kysely-store";

const read = (f: string) => readFileSync(fileURLToPath(new URL(`../../../../../../packages/db/migrations/${f}`, import.meta.url)), "utf8");
const open: ProductMediaDb[] = [];
const A = "00000000-0000-4000-a000-000000000001";
const B = "00000000-0000-4000-a000-000000000002";

/** 0083 depends on 0001-0011 (helpers, RLS roles); 0085 also alters product_media (catalog 0012, so 0013 is the ceiling). */
const fresh = async () => {
  const raw = await createTestDatabaseUpTo(13);
  await raw.exec(read("0083_product_media.sql"));
  await raw.exec(read("0085_product_media_attach.sql"));
  await raw.exec(read("0087_product_media_versions.sql"));
  const db: ProductMediaDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  return { store: new KyselyProductMediaStore(db), raw };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeProductMediaStoreContract("kysely/pglite", fresh);

describe("0083 row level security and graveyard", () => {
  it("scopes seller reads to app_store_ids and buries every blob key on delete", async () => {
    const { store, raw } = await fresh();
    await store.insertJob(job(1));
    await store.insertJob(job(2, { storeId: B }));
    const count = async (role: string, stores: string) => {
      await raw.exec("BEGIN");
      await raw.exec("SET LOCAL ROLE app_user");
      await raw.query("SELECT set_config('app.role', $1, true), set_config('app.store_ids', $2, true)", [role, stores]);
      const r = await raw.query<{ n: number }>("SELECT count(*)::int AS n FROM product_media_jobs");
      await raw.exec("COMMIT");
      return r.rows[0]?.n;
    };
    expect(await count("seller", A)).toBe(1);
    expect(await count("seller", "")).toBe(0);
    expect(await count("system", "")).toBe(2);
    await raw.exec("UPDATE product_media_jobs SET status = 'PROCESSING' WHERE store_id = '" + A + "'");
    await raw.exec(
      "UPDATE product_media_jobs SET status='READY', quality_score=90, png_ref='product-media-derived/2026/10/p', white_jpg_ref='product-media-derived/2026/10/w', shadow_ref='product-media-derived/2026/10/s' WHERE store_id = '" + A + "'",
    );
    await raw.exec("DELETE FROM product_media_jobs WHERE store_id = '" + A + "'");
    const g = await raw.query<{ upload_id: string }>("SELECT upload_id FROM product_media_blob_graveyard ORDER BY upload_id");
    expect(g.rows.map((r) => r.upload_id)).toEqual([
      "product-media-derived/2026/10/p",
      "product-media-derived/2026/10/s",
      "product-media-derived/2026/10/w",
      `product-media/2026/10/00000000-0000-4000-8000-000000000001`,
    ]);
  });

  it("refuses a READY row without outputs", async () => {
    const { store, raw } = await fresh();
    await store.insertJob(job(3));
    await expect(raw.exec("UPDATE product_media_jobs SET status = 'READY'")).rejects.toThrow();
  });
});
