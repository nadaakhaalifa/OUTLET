import { randomUUID } from "node:crypto";
import { contextClient } from "@outlet/db";
import type { SqlClient } from "@outlet/db";
import { FlagService, InMemoryFlagStore } from "@outlet/flags";
import { createTestClient, roleClient } from "@outlet/db/testing";
import { uuidv7 } from "@outlet/ids";
import type { OutboxEvent } from "@outlet/outbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DAY_MS, PRICE_WATCH_KILL_SWITCH, PriceEventIngestor, PriceEvidencePublic, PriceSnapshotService, makeEnv } from "../src/index.js";

const T0 = new Date("2026-10-01T09:00:00.000Z");
const MARKET = "EG";
let raw: SqlClient;
let close: () => Promise<void>;
let clock = T0;
let killed: boolean | "throw" = false;

const env = () =>
  makeEnv({
    client: roleClient(raw, "outlet_app"),
    marketId: MARKET,
    now: () => clock,
    killSwitch: { isKilled: () => (killed === "throw" ? Promise.reject(new Error("flag store down")) : Promise.resolve(killed)) },
  });

/** The ingestor is worker-side code: its inbox row needs a worker job context (inbox_processed RLS, migration 0040), so it gets a worker context client. */
const ingestEnv = () => makeEnv({ client: contextClient(roleClient(raw, "outlet_worker"), { kind: "worker", marketId: "EG", job: "pricing.channels" }), marketId: "EG", now: () => clock, killSwitch: { isKilled: () => Promise.resolve(false) } });

const day = (n: number): Date => new Date(T0.getTime() + n * DAY_MS);

const priceChanged = (skuId: string, priceMinor: number, changedAt: Date, id = uuidv7()): OutboxEvent => ({
  id,
  type: "price.changed",
  aggregateType: "sku",
  aggregateId: skuId,
  marketId: MARKET,
  occurredAt: changedAt.toISOString(),
  visibility: "internal",
  payload: {
    sku_id: skuId,
    product_id: randomUUID(),
    store_id: randomUUID(),
    old_price_minor: null,
    new_price_minor: String(priceMinor),
    currency: "EGP",
    source: "seller",
    changed_at: changedAt.toISOString(),
  },
});

/** Ingests a change as of `daysFromT0` and advances the injected clock to it. */
const change = async (skuId: string, priceMinor: number, daysFromT0: number) => {
  clock = day(daysFromT0);
  return new PriceEventIngestor(ingestEnv()).ingest(priceChanged(skuId, priceMinor, clock));
};

beforeAll(async () => {
  ({ client: raw, close } = await createTestClient());
});
afterAll(async () => {
  await close();
});

describe("PriceEventIngestor", () => {
  it("is idempotent: a duplicate event creates no second row", async () => {
    const sku = randomUUID();
    const e = priceChanged(sku, 1000, T0);
    clock = T0;
    const ing = new PriceEventIngestor(ingestEnv());
    expect(await ing.ingest(e)).toBe("applied");
    expect(await ing.ingest(e)).toBe("duplicate");
    const n = await raw.query<{ n: string }>("SELECT count(*)::text AS n FROM price_events WHERE sku_id = $1", [sku]);
    expect(n.rows[0]?.n).toBe("1");
  });

  it("closes the open row and opens a new one in the same transaction; unchanged, stale and foreign events are no-ops", async () => {
    const sku = randomUUID();
    expect(await change(sku, 1000, 0)).toBe("applied");
    expect(await change(sku, 1000, 1)).toBe("unchanged");
    expect(await change(sku, 800, 2)).toBe("applied");
    clock = day(3);
    expect(await new PriceEventIngestor(ingestEnv()).ingest(priceChanged(sku, 700, day(2)))).toBe("stale"); // a different price at the same instant
    expect(await new PriceEventIngestor(ingestEnv()).ingest({ ...priceChanged(sku, 1, day(3)), type: "listing.updated" })).toBe("ignored");
    const rows = await raw.query<{ price_minor: string; valid_to: Date | null }>("SELECT price_minor::text, valid_to FROM price_events WHERE sku_id = $1 ORDER BY valid_from", [sku]);
    expect(rows.rows.map((r) => r.price_minor)).toEqual(["1000", "800"]);
    expect(rows.rows[0]?.valid_to).toEqual(day(2));
    expect(rows.rows[1]?.valid_to).toBeNull();
  });

  it("applies out-of-order events as closed rows and recomputes the window (redelivery cannot lose a low price)", async () => {
    const sku = randomUUID();
    await change(sku, 1000, 0);
    await change(sku, 900, 40);
    clock = day(41);
    // the day-20 event (a 600 low) arrives after the day-40 one
    expect(await new PriceEventIngestor(ingestEnv()).ingest(priceChanged(sku, 600, day(20)))).toBe("applied");
    const rows = await raw.query<{ price_minor: string; valid_from: Date; valid_to: Date | null }>("SELECT price_minor::text, valid_from, valid_to FROM price_events WHERE sku_id = $1 ORDER BY valid_from", [sku]);
    expect(rows.rows.map((r) => r.price_minor)).toEqual(["1000", "600", "900"]);
    expect(rows.rows[1]?.valid_to).toEqual(day(40));
    expect(rows.rows[2]?.valid_to).toBeNull();
    const w = await raw.query<{ low_30d_minor: string }>("SELECT low_30d_minor::text FROM sku_price_windows WHERE sku_id = $1", [sku]);
    expect(w.rows[0]?.low_30d_minor).toBe("600");
    const ev = await new PriceEvidencePublic(env()).get(sku);
    // effective history is not overlapping: each row ends where the next begins
    expect(ev?.history.map((h) => h.validTo)).toEqual([day(20).toISOString(), day(40).toISOString(), null]);
    // a late event before the very first row, and an equal-to-prior late event
    expect(await new PriceEventIngestor(ingestEnv()).ingest(priceChanged(sku, 600, day(30)))).toBe("unchanged");
    expect(await new PriceEventIngestor(ingestEnv()).ingest(priceChanged(sku, 1200, day(-5)))).toBe("applied");
  });

  it("rejects a malformed payload and a currency change on the open row", async () => {
    const sku = randomUUID();
    clock = T0;
    const bad = priceChanged(sku, 100, T0);
    await expect(new PriceEventIngestor(ingestEnv()).ingest({ ...bad, payload: { ...bad.payload, new_price_minor: "-5" } })).rejects.toThrow();
    await change(sku, 100, 0);
    clock = day(1);
    const other = priceChanged(sku, 90, day(1));
    await expect(new PriceEventIngestor(ingestEnv()).ingest({ ...other, payload: { ...other.payload, currency: "USD" } })).rejects.toThrow(/currency/);
    // the failed attempt rolled back with its inbox row: the same event id can be retried once corrected
    expect(await new PriceEventIngestor(ingestEnv()).ingest(other)).toBe("applied");
  });

  it("maintains the window across 40 days with an injected clock", async () => {
    const sku = randomUUID();
    await change(sku, 1000, 0);
    await change(sku, 900, 10);
    await change(sku, 1100, 20);
    await change(sku, 950, 40);
    const w = await raw.query(
      "SELECT current_price_minor::text AS cur, low_30d_minor::text AS low, low_30d_from, first_seen_at, last_increase_at, updated_at FROM sku_price_windows WHERE sku_id = $1",
      [sku],
    );
    expect(w.rows).toHaveLength(1);
    expect(w.rows[0]).toMatchObject({ cur: "950", low: "900", low_30d_from: day(10), first_seen_at: day(0), last_increase_at: day(20), updated_at: day(40) });
  });

  it("window row at an intermediate day reflects the then-current 30 day low", async () => {
    const sku = randomUUID();
    await change(sku, 1000, 0);
    await change(sku, 900, 10);
    await change(sku, 1100, 25);
    const w = await raw.query<{ low: string; cur: string }>("SELECT low_30d_minor::text AS low, current_price_minor::text AS cur FROM sku_price_windows WHERE sku_id = $1", [sku]);
    expect(w.rows[0]).toEqual({ low: "900", cur: "1100" });
  });
});

describe("append-only guard and grants", () => {
  it("blocks UPDATE of anything but valid_to on the open row, and all DELETE / TRUNCATE", async () => {
    const sku = randomUUID();
    await change(sku, 500, 0);
    await expect(raw.query("UPDATE price_events SET price_minor = 1 WHERE sku_id = $1", [sku])).rejects.toThrow(/append-only/);
    await expect(raw.query("DELETE FROM price_events WHERE sku_id = $1", [sku])).rejects.toThrow(/append-only/);
    await expect(raw.query("TRUNCATE price_events")).rejects.toThrow(/append-only/);
    await raw.query("UPDATE price_events SET valid_to = $2 WHERE sku_id = $1", [sku, day(1)]);
    // a closed row can never change again
    await expect(raw.query("UPDATE price_events SET valid_to = $2 WHERE sku_id = $1", [sku, day(2)])).rejects.toThrow(/append-only/);
  });

  it("outlet_app cannot delete or rewrite price columns even without the trigger", async () => {
    const app = roleClient(raw, "outlet_app");
    await expect(app.query("DELETE FROM price_events")).rejects.toThrow(/permission denied/);
    await expect(app.query("UPDATE price_events SET price_minor = 1")).rejects.toThrow(/permission denied/);
  });
});

describe("PriceSnapshotService and PriceEvidencePublic", () => {
  it("launch price before day 30, verified discount once history allows it", async () => {
    killed = false;
    const early = randomUUID();
    await change(early, 1000, 0);
    await change(early, 700, 20);
    const snapEarly = await new PriceSnapshotService(env()).snapshotForOrderLine(early);
    expect(snapEarly).toEqual({ vrp: null, evidenceIds: [], claimType: "launch_price" });
    const evEarly = await new PriceEvidencePublic(env()).get(early);
    expect(evEarly).toMatchObject({ label: "launch_price", discountPct: null, referencePrice: null, launchPrice: true });

    const later = randomUUID();
    await change(later, 1000, 0);
    await change(later, 700, 31);
    const snap = await new PriceSnapshotService(env()).snapshotForOrderLine(later);
    expect(snap.claimType).toBe("verified_discount");
    expect(snap.vrp).toEqual({ amountMinor: 1000n, currency: "EGP" });
    expect(snap.evidenceIds).toHaveLength(2);
    const ev = await new PriceEvidencePublic(env()).get(later);
    expect(ev).toMatchObject({ label: "verified", discountPct: 30, referencePrice: { amountMinor: "1000", currency: "EGP" }, currentPrice: { amountMinor: "700", currency: "EGP" } });
    expect(ev?.history).toHaveLength(2);
    // brand mode narrows, never widens
    expect(await new PriceEvidencePublic(env()).get(later, { brandMode: "member_only" })).toMatchObject({ label: "lowest_30d", discountPct: null, referencePrice: null });
    expect(await new PriceEvidencePublic(env()).get(later, { brandMode: "member_only", viewer: "member" })).toMatchObject({ label: "verified", discountPct: 30 });
    expect(await new PriceEvidencePublic(env()).get(later, { brandMode: "hidden", viewer: "member" })).toMatchObject({ label: "lowest_30d", discountPct: null });
  });

  it("anti-inflation: raise then cut shows no claim; a deeper cut claims against the true low", async () => {
    killed = false;
    const sku = randomUUID();
    await change(sku, 100, 0);
    await change(sku, 200, 35);
    await change(sku, 120, 40);
    expect((await new PriceSnapshotService(env()).snapshotForOrderLine(sku)).claimType).toBe("plain");
    await change(sku, 80, 41);
    const s = await new PriceSnapshotService(env()).snapshotForOrderLine(sku);
    expect(s.claimType).toBe("verified_discount");
    expect(s.vrp?.amountMinor).toBe(100n);
  });

  it("lowest_30d label when the price is the 30 day low without a 5 percent claim", async () => {
    killed = false;
    const sku = randomUUID();
    await change(sku, 1000, 0);
    await change(sku, 980, 40);
    expect((await new PriceSnapshotService(env()).snapshotForOrderLine(sku)).claimType).toBe("lowest_30d");
  });

  it("public evidence carries no actor or event ids", async () => {
    killed = false;
    const sku = randomUUID();
    await change(sku, 1000, 0);
    const ev = await new PriceEvidencePublic(env()).get(sku);
    const json = JSON.stringify(ev);
    expect(json).not.toMatch(/actor|source|"id"|store/);
    expect(await new PriceEvidencePublic(env()).get(randomUUID())).toBeNull();
    expect(await new PriceSnapshotService(env()).snapshotForOrderLine(randomUUID())).toEqual({ vrp: null, evidenceIds: [], claimType: "plain" });
  });

  it.each([true, "throw"] as const)("kill switch (%s) shows plain prices everywhere, fail closed", async (mode) => {
    const sku = randomUUID();
    killed = false;
    await change(sku, 1000, 0);
    await change(sku, 700, 31);
    expect((await new PriceSnapshotService(env()).snapshotForOrderLine(sku)).claimType).toBe("verified_discount");
    killed = mode;
    expect(await new PriceSnapshotService(env()).snapshotForOrderLine(sku)).toEqual({ vrp: null, evidenceIds: [], claimType: "plain" });
    expect(await new PriceEvidencePublic(env()).get(sku)).toMatchObject({ label: "plain", discountPct: null, referencePrice: null, lowest30d: null, history: [] });
    // evidence keeps being recorded while display is killed
    expect(await change(sku, 650, 32)).toBe("applied");
    killed = false;
  });

  it("names the registered kill switch", () => {
    expect(PRICE_WATCH_KILL_SWITCH).toBe("pricing.price_watch.enabled");
  });

  it("engaging the registered switch in the real FlagService hides discounts; releasing restores them", async () => {
    const flags = new FlagService({ store: new InMemoryFlagStore(), audit: { record: () => Promise.resolve() }, ttlMs: 0, maxStaleMs: 0 });
    const wired = () =>
      makeEnv({ client: roleClient(raw, "outlet_app"), marketId: MARKET, now: () => clock, killSwitch: { isKilled: () => flags.isKilled(PRICE_WATCH_KILL_SWITCH, { marketId: MARKET }) } });
    const sku = randomUUID();
    killed = false;
    await change(sku, 1000, 0);
    await change(sku, 700, 31);
    expect((await new PriceSnapshotService(wired()).snapshotForOrderLine(sku)).claimType).toBe("verified_discount");
    await flags.engageKillSwitch(PRICE_WATCH_KILL_SWITCH, "test");
    expect(await new PriceSnapshotService(wired()).snapshotForOrderLine(sku)).toEqual({ vrp: null, evidenceIds: [], claimType: "plain" });
    expect(await new PriceEvidencePublic(wired()).get(sku)).toMatchObject({ label: "plain", discountPct: null, referencePrice: null });
    await flags.releaseKillSwitch(PRICE_WATCH_KILL_SWITCH, "test");
    expect((await new PriceSnapshotService(wired()).snapshotForOrderLine(sku)).claimType).toBe("verified_discount");
  });
});
