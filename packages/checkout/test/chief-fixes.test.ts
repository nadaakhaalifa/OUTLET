import { uuidv7 } from "@outlet/ids";
import { money } from "@outlet/money";
import fc from "fast-check";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sellerAmounts, splitInstructions } from "../src/domain/split.js";
import type { StoreQuote } from "../src/domain/types.js";
import { FakeAddressSnapshots } from "../src/testing.js";
import { ADDR, buildWorld, errCode } from "./fixtures.js";
import type { Sku, World } from "./fixtures.js";

let w: World;
let u: string;
let sku: Sku;

beforeAll(async () => { w = await buildWorld(); });
afterAll(async () => { await w.close(); });
beforeEach(async () => {
  w.fakes.address.version = "v1";
  w.fakes.address.codEligible = true;
  w.fakes.provider.nextCreate = "requires_action";
  u = await w.newUser();
  sku = await w.seedSku(w.stores[0], 100_000n, 20);
  w.fakes.shipping.fees.set(w.stores[0], 0n);
  await w.raw.query("UPDATE promotions SET status = 'ENDED'");
});

const input = (q: Awaited<ReturnType<World["svc"]["quote"]>>) => ({ addressRef: ADDR, method: "card" as const, idempotencyKey: uuidv7(), quoteToken: q.token, quote: q.quote });

describe("address snapshot is part of the order transaction (chief review 1)", () => {
  it("an address deleted between quote and place: no order is placed and nothing leaks", async () => {
    const snaps = new FakeAddressSnapshots();
    const svc = w.makeSvc({}, { addressSnapshots: snaps });
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const q = await svc.quote(u, { addressRef: ADDR, method: "card" });
    snaps.missing.add(ADDR);
    const i = input(q);
    expect(await errCode(svc.place(u, i))).toBe("address-not-found");
    expect((await w.raw.query("SELECT 1 FROM order_groups WHERE idempotency_key = $1", [i.idempotencyKey])).rows).toHaveLength(0);
    expect(await w.free(sku)).toBe(20);
  });

  it("an address edited between quote and place yields price-changed with an address delta", async () => {
    const svc = w.makeSvc({}, { addressSnapshots: new FakeAddressSnapshots() });
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const q = await svc.quote(u, { addressRef: ADDR, method: "card" });
    w.fakes.address.version = "v2";
    const e = await svc.place(u, input(q)).then(() => null, (x: unknown) => x);
    expect(e).toMatchObject({ code: "price-changed", status: 409 });
    expect((e as { details: { deltas: { kind: string }[] } }).details.deltas).toContainEqual({ kind: "address" });
  });

  it("snapshot rows exist iff the order exists (one per seller order)", async () => {
    const snaps = new FakeAddressSnapshots();
    const svc = w.makeSvc({}, { addressSnapshots: snaps });
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const q = await svc.quote(u, { addressRef: ADDR, method: "card" });
    const res = await svc.place(u, input(q));
    const so = (await w.raw.query<{ id: string }>("SELECT id FROM seller_orders WHERE order_group_id = $1", [res.orderGroupId])).rows.map((r) => r.id);
    expect(snaps.calls.map((c) => c.sellerOrderId).sort()).toEqual(so.sort());
  });
});

describe("platform-funded discount cap (chief review 2, ADR-0013 Proposed)", () => {
  it("a platform voucher above commission + VAT is refused with platform-discount-cap; an automatic one is dropped", async () => {
    const { randomUUID } = await import("node:crypto");
    const id = randomUUID();
    await w.raw.query(
      `INSERT INTO promotions (id, market_id, owner_type, store_id, type, name_ar, rules, stacking_class, funding_platform_bp, funding_seller_bp, currency, starts_at, ends_at, status, version)
       VALUES ($1,'EG','platform',NULL,'fixed','عرض',$2::jsonb,'auto',10000,0,'EGP','2029-12-01T00:00:00Z','2031-01-01T00:00:00Z','ACTIVE',1)`,
      [id, JSON.stringify({ level: "order", discount: { kind: "fixed", amountMinor: "50000" } })],
    );
    await w.raw.query("INSERT INTO promotion_usage (promotion_id, store_id, market_id, currency) VALUES ($1,NULL,'EG','EGP')", [id]);
    const { makePromotionsPort } = await import("../src/index.js");
    const { FakeAudit, FakeKill } = await import("@outlet/promotions/testing");
    const svc = w.makeSvc({}, { promotions: makePromotionsPort({ client: w.app, marketId: "EG", kill: new FakeKill(), audit: new FakeAudit(), hmacKey: new Uint8Array(32).fill(7), now: w.now, velocityPerHour: 1000 }) });
    await w.fillBag(u, [{ sku, qty: 1 }]);
    // 50,000 off a 100,000 store at 15% commission (+14% VAT) = 17,100 cap
    expect(await errCode(svc.quote(u, { addressRef: ADDR, method: "card", voucherCodes: ["WHATEVER"] }))).toBe("platform-discount-cap");
    const q = await svc.quote(u, { addressRef: ADDR, method: "card" });
    expect(q.quote.discount.amountMinor).toBe(0n);
    await w.raw.query("UPDATE promotions SET status = 'ENDED' WHERE id = $1", [id]);
  });
});

const EGP = "EGP" as const;
const store = (items: bigint, sellerGoods: bigint, platformGoods: bigint, ship: bigint, platformShip: bigint, sellerShip: bigint): StoreQuote => {
  const m = (x: bigint) => money(x, EGP);
  const total = items + ship - platformGoods - sellerGoods - platformShip - sellerShip;
  return {
    storeId: "s", itemsSubtotal: m(items), shipping: { gross: m(ship), vat: m(0n), quoteRef: "q", etaDaysMin: 1, etaDaysMax: 2 }, shippingDiscount: { platform: m(platformShip), seller: m(sellerShip) },
    platformDiscount: m(platformGoods + platformShip), sellerDiscount: m(sellerGoods + sellerShip), vat: m(0n), total: m(total),
    lines: [{ sellerDiscount: m(sellerGoods) }],
  } as unknown as StoreQuote;
};

describe("split property: seller PSP share == seller_net_minor when the cap holds", () => {
  it("holds for every capped store (no store credit)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1000n, max: 10_000_000n }), fc.integer({ min: 0, max: 5000 }), fc.bigInt({ min: 0n, max: 50_000n }), fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 100 }),
        (items, bp, ship, sellerPct, platPct, shipPct) => {
          const sellerGoods = (items * BigInt(sellerPct)) / 200n;
          const sellerShip = (ship * BigInt(shipPct)) / 200n;
          const base = items - sellerGoods;
          const commission = (base * BigInt(bp)) / 10_000n;
          const platformCap = commission + (commission * 1400n) / 10_000n;
          const platformGoods = (platformCap * BigInt(platPct)) / 100n;
          const s = store(items, sellerGoods, platformGoods, ship, 0n, sellerShip);
          let a;
          try {
            a = sellerAmounts(s, bp, 1400);
          } catch {
            return; // seller net below zero: refused earlier by invariant I13
          }
          if (a.platformDiscount.amountMinor > a.commission.amountMinor + a.commissionVat.amountMinor) return; // outside the cap: refused at quote
          const [ins] = splitInstructions([a], a.total, new Map([["s", "so"]]), new Map([["s", "sub"]]));
          expect(ins?.sellerAmount.amountMinor).toBe(a.net.amountMinor);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("voucher settle survives a failed post-commit confirm (chief review 3)", () => {
  it("emits promotions.settle_requested in the order tx; the consumer confirms, is idempotent and retries after a failure", async () => {
    const { randomUUID } = await import("node:crypto");
    const { PromotionsSettleConsumer, makePromotionsPort } = await import("../src/index.js");
    const { FakeAudit, FakeKill } = await import("@outlet/promotions/testing");
    const id = randomUUID();
    await w.raw.query(
      `INSERT INTO promotions (id, market_id, owner_type, store_id, type, name_ar, rules, stacking_class, funding_platform_bp, funding_seller_bp, currency, starts_at, ends_at, status, version)
       VALUES ($1,'EG','platform',NULL,'fixed','عرض',$2::jsonb,'auto',10000,0,'EGP','2029-12-01T00:00:00Z','2031-01-01T00:00:00Z','ACTIVE',1)`,
      [id, JSON.stringify({ level: "order", discount: { kind: "fixed", amountMinor: "10000" } })],
    );
    await w.raw.query("INSERT INTO promotion_usage (promotion_id, store_id, market_id, currency) VALUES ($1,NULL,'EG','EGP')", [id]);
    const real = makePromotionsPort({ client: w.app, marketId: "EG", kill: new FakeKill(), audit: new FakeAudit(), hmacKey: new Uint8Array(32).fill(7), now: w.now, velocityPerHour: 1000 });
    let failing = true;
    const flaky = { ...real, confirm: (a: string, b: string) => (failing ? Promise.reject(new Error("db blip")) : real.confirm(a, b)) };
    const svc = w.makeSvc({}, { promotions: flaky });
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const q = await svc.quote(u, { addressRef: ADDR, method: "cod" });
    const res = await svc.place(u, { addressRef: ADDR, method: "cod", idempotencyKey: uuidv7(), quoteToken: q.token, quote: q.quote });
    const kinds = async (): Promise<string[]> => (await w.raw.query<{ kind: string }>("SELECT kind FROM voucher_redemptions WHERE order_group_id = $1 ORDER BY kind", [res.orderGroupId])).rows.map((r) => r.kind);
    expect(await kinds()).toEqual(["reserved"]);
    const ev = (await w.raw.query<{ id: string; payload: Record<string, unknown> }>("SELECT id, payload FROM outbox_events WHERE event_type = 'promotions.settle_requested' AND payload ->> 'order_group_id' = $1", [res.orderGroupId])).rows[0];
    expect(ev).toBeDefined();
    const consumer = new PromotionsSettleConsumer(w.raw, flaky);
    await expect(consumer.handle(ev ?? { id: "", payload: {} })).rejects.toThrow("db blip");
    failing = false;
    expect(await consumer.handle(ev ?? { id: "", payload: {} })).toBe("processed");
    expect(await kinds()).toEqual(["confirmed", "reserved"]);
    expect(await consumer.handle(ev ?? { id: "", payload: {} })).toBe("duplicate");
    await w.raw.query("UPDATE promotions SET status = 'ENDED' WHERE id = $1", [id]);
  });
});
