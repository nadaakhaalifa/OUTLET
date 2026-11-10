import { randomUUID } from "node:crypto";
import { contextClient } from "@outlet/db";
import type { SqlClient } from "@outlet/db";
import { createTestClient, roleClient } from "@outlet/db/testing";
import { uuidv7 } from "@outlet/ids";
import type { OutboxEvent } from "@outlet/outbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DAY_MS, PriceEventIngestor, PriceSnapshotService, makeEnv } from "../src/index.js";

const T0 = new Date("2026-10-01T09:00:00.000Z");
let raw: SqlClient;
let close: () => Promise<void>;
let clock = T0;
let storeId = "";
/** Superuser client: price_claims is store-RLS-isolated for outlet_app, so the shopper read path needs a context-free reader (see report). */
const privileged = () => makeEnv({ client: raw, marketId: "EG", now: () => clock, killSwitch: { isKilled: () => Promise.resolve(false) } });
/** The ingestor is worker-side code: its inbox row needs a worker job context (inbox_processed RLS, migration 0040), so it gets a worker context client. */
const ingestEnv = () => makeEnv({ client: contextClient(roleClient(raw, "outlet_worker"), { kind: "worker", marketId: "EG", job: "pricing.channels" }), marketId: "EG", now: () => clock, killSwitch: { isKilled: () => Promise.resolve(false) } });

const day = (n: number): Date => new Date(T0.getTime() + n * DAY_MS);

const change = async (sku: string, price: number, d: number): Promise<void> => {
  clock = day(d);
  const e: OutboxEvent = {
    id: uuidv7(), type: "price.changed", aggregateType: "sku", aggregateId: sku, marketId: "EG", occurredAt: clock.toISOString(), visibility: "internal",
    payload: { sku_id: sku, product_id: randomUUID(), store_id: storeId, old_price_minor: null, new_price_minor: String(price), currency: "EGP", source: "seller", changed_at: clock.toISOString() },
  };
  await new PriceEventIngestor(ingestEnv()).ingest(e);
};
/** 1000 -> 700 on day 31: the internal history alone justifies a verified discount against 1000. */
const discounted = async (): Promise<string> => {
  const sku = randomUUID();
  await change(sku, 1000, 0);
  await change(sku, 700, 31);
  return sku;
};
const claim = (sku: string, o: { allowed: boolean; vrp: number | null; evidence?: string[]; validUntil?: Date | null }) =>
  raw.query(
    `INSERT INTO price_claims (id, sku_id, store_id, market_id, price_minor, vrp_minor, currency, reference_class, discount_bp, claim_type, display_allowed, trust_score, status, rule_version, reason, evidence_ids, scored_at, valid_until)
     VALUES ($1,$2,$3,'EG',700,$4,'EGP','external',0,$5,$6,50,'active','v1','t',$7::uuid[],$8,$9)`,
    [randomUUID(), sku, storeId, o.vrp, o.allowed ? "verified_discount" : "plain", o.allowed, o.evidence ?? [], clock, o.validUntil ?? null],
  );

beforeAll(async () => {
  ({ client: raw, close } = await createTestClient());
  const sellerId = randomUUID();
  storeId = randomUUID();
  await raw.query("INSERT INTO sellers (id, home_market_id, market_id, legal_type) VALUES ($1, 'EG', 'EG', 'company')", [sellerId]);
  await raw.query("INSERT INTO stores (id, seller_id, market_id, slug, display_name_ar, kind, ships_from_country) VALUES ($1, $2, 'EG', $3, 'متجر', 'local', 'EG')", [storeId, sellerId, "snap-claims"]);
});
afterAll(async () => {
  await close();
});

describe("PriceSnapshotService with a live claim row", () => {
  it("baseline: internal history only yields a verified snapshot against 1000", async () => {
    const s = await new PriceSnapshotService(privileged()).snapshotForOrderLine(await discounted());
    expect(s.claimType).toBe("verified_discount");
    expect(s.vrp?.amountMinor).toBe(1000n);
    expect(s.evidenceIds.length).toBeGreaterThan(0);
  });
  it("a claim that disallows display withdraws the % (fail closed to plain)", async () => {
    const sku = await discounted();
    await claim(sku, { allowed: false, vrp: null });
    expect(await new PriceSnapshotService(privileged()).snapshotForOrderLine(sku)).toEqual({ vrp: null, evidenceIds: [], claimType: "lowest_30d" });
  });
  it("an expired claim is treated as not displayable", async () => {
    const sku = await discounted();
    await claim(sku, { allowed: true, vrp: 900, validUntil: day(30) });
    expect((await new PriceSnapshotService(privileged()).snapshotForOrderLine(sku)).vrp).toBeNull();
  });
  it("a stricter (lower) external reference lowers the VRP and adds its evidence to the trail", async () => {
    const sku = await discounted();
    const ext = randomUUID();
    await claim(sku, { allowed: true, vrp: 900, evidence: [ext] });
    const s = await new PriceSnapshotService(privileged()).snapshotForOrderLine(sku);
    expect(s.vrp?.amountMinor).toBe(900n);
    expect(s.evidenceIds).toContain(ext);
    expect(s.claimType).toBe("verified_discount");
  });
  it("a higher or absent external reference never raises the VRP above the internal one (DB forbids an allowed claim without a VRP)", async () => {
    const hi = await discounted();
    await claim(hi, { allowed: true, vrp: 5000, evidence: [randomUUID()] });
    const a = await new PriceSnapshotService(privileged()).snapshotForOrderLine(hi);
    expect(a.vrp?.amountMinor).toBe(1000n);
  });
  it("a claim cannot create a verified discount when internal history has no reference", async () => {
    const sku = randomUUID();
    await change(sku, 700, 0);
    await claim(sku, { allowed: true, vrp: 900 });
    const s = await new PriceSnapshotService(privileged()).snapshotForOrderLine(sku);
    expect(s.claimType).not.toBe("verified_discount");
    expect(s.vrp).toBeNull();
  });
});
