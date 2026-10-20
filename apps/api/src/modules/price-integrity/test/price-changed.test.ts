import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PriceChangedSchema } from "../../auto-buy";
import { createPriceIntegrityDevFixtures } from "../adapters/in-memory";
import { PriceIntegrityService } from "../application/service";
import { DAY, STORE_A, T0, U } from "./contract";
import { createPriceIntegrityPglite, type PriceIntegrityPglite } from "./pglite-fixture";

function setup() {
  const fx = createPriceIntegrityDevFixtures();
  let now = T0;
  let n = 0;
  const service = new PriceIntegrityService({ ...fx, clock: { nowMs: () => now }, ids: { uuidV7: () => U(2000 + (n += 1)) } });
  let k = 0;
  const price = (amount: bigint, ms: number, key?: string) => {
    now = ms;
    return service.recordPriceChange({
      skuId: U(1),
      storeId: STORE_A,
      priceAmount: amount,
      source: "seller",
      actorId: U(7),
      idempotencyKey: key ?? `key-${(k += 1)}`,
    });
  };
  return { fx, price };
}

describe("price.changed producer (in the price_events append)", () => {
  it("emits the auto-buy wire shape; a verified discount is verified and not anomalous", async () => {
    const { fx, price } = setup();
    await price(1_000n, T0);
    await price(800n, T0 + 100 * DAY);
    expect(fx.events.outbox).toHaveLength(2);
    const last = PriceChangedSchema.parse(fx.events.outbox[1]?.payload);
    expect(last).toMatchObject({ sku_id: U(1), price: { amount: "800", currency: "EGP" }, verified: true, anomaly: false });
    expect(last.occurred_at).toBe(new Date(T0 + 100 * DAY).toISOString());
  });

  it("a launch price (no history) is never verified", async () => {
    const { fx, price } = setup();
    await price(1_000n, T0);
    expect(fx.events.outbox[0]?.payload).toMatchObject({ verified: false });
  });

  it("an idempotent replay writes no second event", async () => {
    const { fx, price } = setup();
    await price(1_000n, T0, "same");
    const again = await price(1_000n, T0, "same");
    expect(again.created).toBe(false);
    expect(fx.events.outbox).toHaveLength(1);
  });

  it("inflate-then-cut is flagged: never verified without anomaly", async () => {
    const { fx, price } = setup();
    await price(1_000n, T0);
    await price(1_500n, T0 + 90 * DAY);
    await price(1_000n, T0 + 95 * DAY);
    const p = PriceChangedSchema.parse(fx.events.outbox[2]?.payload);
    expect(p.verified && !p.anomaly).toBe(false);
  });

  it("fails closed when the signal cannot be computed, and the price is still recorded", async () => {
    const fx = createPriceIntegrityDevFixtures();
    const r = await fx.events.append(
      { id: U(1), skuId: U(1), storeId: STORE_A, priceAmount: 500n, validFromMs: T0, source: "seller", actorId: U(7), idempotencyKey: "k" },
      () => {
        throw new Error("boom");
      },
    );
    expect(r.created).toBe(true);
    expect(fx.events.outbox[0]?.payload).toMatchObject({ verified: false, anomaly: true });
    expect(await fx.events.history(U(1))).toHaveLength(1);
  });
});

describe("price.changed producer on Postgres (same transaction as the insert)", () => {
  let h: PriceIntegrityPglite;
  beforeAll(async () => {
    h = await createPriceIntegrityPglite();
  }, 60_000);
  afterAll(async () => {
    await h.close();
  });

  const ev = (n: number, price: bigint, at: number, key: string) => ({
    id: U(300 + n),
    skuId: U(5),
    storeId: STORE_A,
    priceAmount: price,
    validFromMs: at,
    source: "seller" as const,
    actorId: U(1),
    idempotencyKey: key,
  });
  const outbox = async () =>
    (await h.raw.query<{ t: string; p: Record<string, unknown>; agg: string }>(
      `select event_type as t, payload as p, aggregate_id::text as agg from outbox_events where event_type = 'price.changed' order by occurred_at, id`,
    )).rows;

  it("writes one outbox row per created price event, none on replay, and the signal sees the new event", async () => {
    h.setSession({ userId: null, role: "system" });
    const seen: number[] = [];
    const signal = (history: readonly { priceAmount: bigint }[]) => {
      seen.push(history.length);
      return { verified: history.length > 1, anomaly: false };
    };
    await h.events.append(ev(1, 1_000n, T0, "p1"), signal);
    await h.events.append(ev(2, 800n, T0 + 100 * DAY, "p2"), signal);
    const replay = await h.events.append(ev(2, 800n, T0 + 100 * DAY, "p2"), signal);
    expect(replay.created).toBe(false);
    expect(seen).toEqual([1, 2]);
    const rows = await outbox();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.agg).toBe(U(5));
    const parsed = PriceChangedSchema.parse(rows[1]?.p);
    expect(parsed).toMatchObject({ event_id: U(302), price: { amount: "800", currency: "EGP" }, verified: true, anomaly: false });
  });

  it("a conflicting append writes no outbox row (rolled back with the insert)", async () => {
    const before = (await outbox()).length;
    await expect(h.events.append(ev(9, 700n, T0 - DAY, "p9"), () => ({ verified: true, anomaly: false }))).rejects.toThrow();
    expect((await outbox()).length).toBe(before);
  });
});
