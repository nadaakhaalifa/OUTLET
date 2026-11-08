import { randomUUID } from "node:crypto";
import { roleClient } from "@outlet/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DealsReader, SCAN_MAX } from "../src/modules/catalog-public/deals-reader.js";
import type { DealsDeps } from "../src/modules/catalog-public/deals-reader.js";
import { DB_MARKET, T0, createTestApp } from "./harness.js";
import type { TestApp } from "./harness.js";

const DAY = 86_400_000;
let t: TestApp;
let seq = 0;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });

const reader = (over: Partial<DealsDeps> = {}): DealsReader =>
  new DealsReader({ client: roleClient(t.raw, "outlet_app"), marketId: DB_MARKET, now: () => new Date(T0), priceWatchKilled: () => Promise.resolve(false), ...over });

/** A published listing in store A. `variants: []` gives a listing with no SKU at all. */
const listing = async (o: { sku?: boolean; media?: string | null; publishedMinutesAgo?: number } = {}): Promise<{ id: string; sku: string | null }> => {
  const id = randomUUID();
  const sku = o.sku === false ? null : randomUUID();
  const variants = sku === null ? [] : [{ sku_id: sku, option_values: {}, price_minor: "129900", currency: "EGP" }];
  seq += 1;
  await t.raw.query(
    `INSERT INTO catalog_public_listings (id, store_ref, market_id, store, status, title_ar, description_ar, primary_category_id, condition_grade_code, condition_grade, min_price_minor, currency, attributes, variants, main_media_id, main_media_alt_ar, version, published_at, updated_at)
     VALUES ($1,$2,'EG','{"slug":"store-a"}'::jsonb,'PUBLISHED',$3,'وصف',$4,'new_with_tags','{}'::jsonb,129900,'EGP','{}'::jsonb,$5::jsonb,$6,$7,1,$8,$8)`,
    [id, t.seed.storeA, `منتج ${String(seq)}`, t.seed.categoryId, JSON.stringify(variants), o.media ?? null, o.media === null || o.media === undefined ? null : "صورة", new Date(T0 - (o.publishedMinutesAgo ?? seq) * 60_000)],
  );
  return { id, sku };
};
const history = async (sku: string, steps: readonly { price: number; daysAgo: number }[]): Promise<void> => {
  for (const [i, s] of steps.entries()) {
    const next = steps[i + 1];
    await t.raw.query(
      `INSERT INTO price_events (id, sku_id, market_id, currency, price_minor, valid_from, valid_to, source, actor_type) VALUES ($1,$2,$3,'EGP',$4,$5,$6,'internal','system')`,
      [randomUUID(), sku, DB_MARKET, s.price, new Date(T0 - s.daysAgo * DAY), next === undefined ? null : new Date(T0 - next.daysAgo * DAY)],
    );
  }
};
const verifiedHalf = (sku: string) => history(sku, [{ price: 260_000, daysAgo: 50 }, { price: 129_900, daysAgo: 5 }]);
const ids = (p: { items: { product_id: string }[] }): string[] => p.items.map((i) => i.product_id);

describe("DealsReader", () => {
  it("skips listings that cannot honestly carry a verified percentage: no SKU, no price history, or no currently open price", async () => {
    const noSku = await listing({ sku: false });
    const noHistory = await listing();
    const closedOnly = await listing();
    await history(closedOnly.sku ?? "", [{ price: 260_000, daysAgo: 60 }, { price: 129_900, daysAgo: 40 }]);
    await t.raw.query("UPDATE price_events SET valid_to = $2 WHERE sku_id = $1 AND valid_to IS NULL", [closedOnly.sku, new Date(T0 - 35 * DAY)]);
    const good = await listing();
    await verifiedHalf(good.sku ?? "");
    const out = ids(await reader().list({ limit: 20 }));
    expect(out).toContain(good.id);
    for (const bad of [noSku.id, noHistory.id, closedOnly.id]) expect(out).not.toContain(bad);
  });

  it("an image is attached only when the listing has a main media id, via the default /media/{id} url or an injected builder", async () => {
    const media = randomUUID();
    const withImg = await listing({ media });
    await verifiedHalf(withImg.sku ?? "");
    const without = await listing({ media: null });
    await verifiedHalf(without.sku ?? "");
    const byId = (p: { items: { product_id: string; image: unknown }[] }, id: string) => p.items.find((i) => i.product_id === id)?.image;
    const def = await reader().list({ limit: 50 });
    expect(byId(def, withImg.id)).toEqual({ media_id: media, url: `/media/${media}`, alt_ar: "صورة" });
    expect(byId(def, without.id)).toBeNull();
    const custom = await reader({ mediaUrl: (m) => `https://cdn.test/${m}.webp` }).list({ limit: 50 });
    expect(byId(custom, withImg.id)).toMatchObject({ url: `https://cdn.test/${media}.webp` });
  });

  it("a page holds at most `limit` deals and its cursor resumes after the last candidate judged: pages never overlap and together cover every deal", async () => {
    const made: string[] = [];
    for (let i = 0; i < 3; i++) { const l = await listing({ publishedMinutesAgo: 1000 + i }); await verifiedHalf(l.sku ?? ""); made.push(l.id); }
    const r = reader();
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await r.list({ limit: 1, ...(cursor === undefined ? {} : { cursor }) });
      expect(page.items.length).toBeLessThanOrEqual(1);
      seen.push(...ids(page));
      cursor = page.next_cursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined && pages < 200);
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of made) expect(seen).toContain(id);
  });

  it("the scan is bounded: with more than SCAN_MAX non-qualifying candidates the first page is empty but carries a cursor (honest, bounded work)", async () => {
    const app2 = await createTestApp();
    try {
      for (let i = 0; i < SCAN_MAX + 5; i++) {
        await app2.raw.query(
          `INSERT INTO catalog_public_listings (id, store_ref, market_id, store, status, title_ar, description_ar, primary_category_id, condition_grade_code, condition_grade, min_price_minor, currency, attributes, variants, version, published_at, updated_at)
           VALUES ($1,$2,'EG','{"slug":"store-a"}'::jsonb,'PUBLISHED','x','وصف',$3,'new_with_tags','{}'::jsonb,1,'EGP','{}'::jsonb,'[]'::jsonb,1,$4,$4)`,
          [randomUUID(), app2.seed.storeA, app2.seed.categoryId, new Date(T0 - (i + 1) * 1000)],
        );
      }
      const r = new DealsReader({ client: roleClient(app2.raw, "outlet_app"), marketId: DB_MARKET, now: () => new Date(T0), priceWatchKilled: () => Promise.resolve(false) });
      const first = await r.list({ limit: 5 });
      expect(first.items).toEqual([]);
      expect(first.next_cursor).toEqual(expect.any(String));
      const second = await r.list({ limit: 5, cursor: first.next_cursor ?? "" });
      expect(second.items).toEqual([]);
    } finally {
      await app2.close();
    }
  });

  it("a malformed cursor is a validation error and a killed Price Watch short-circuits before any cursor is parsed", async () => {
    await expect(reader().list({ limit: 5, cursor: "garbage" })).rejects.toMatchObject({ code: "validation" });
    expect(await reader({ priceWatchKilled: () => Promise.resolve(true) }).list({ limit: 5, cursor: "garbage" })).toEqual({ items: [], next_cursor: null });
  });

  it("a deal below the band floor is excluded: a 20% cut is never listed in any band", async () => {
    const small = await listing();
    await history(small.sku ?? "", [{ price: 162_375, daysAgo: 50 }, { price: 129_900, daysAgo: 5 }]);
    for (const band of [undefined, "49_40", "59_50", "70_60"] as const) expect(ids(await reader().list({ limit: 50, ...(band === undefined ? {} : { band }) }))).not.toContain(small.id);
  });
});
