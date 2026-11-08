import { randomUUID } from "node:crypto";
import { uuidv7 } from "@outlet/ids";
import { accountCode } from "@outlet/ledger";
import type { PromotionsPort } from "../src/index.js";
import { PROMOTIONS_KILL_SWITCH, makePromotionsPort } from "../src/index.js";
import { FakeAddressSnapshots } from "../src/testing.js";
import { FakeAudit, FakeKill } from "@outlet/promotions/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ADDR, buildWorld, errCode, intentOf, paidWebhook, quoteAndPlace } from "./fixtures.js";
import type { Sku, World } from "./fixtures.js";

let w: World;
let u: string;
let skuA: Sku;
let skuB: Sku;
const promoKill = new FakeKill();
const KEY = new Uint8Array(32).fill(7);
const real = (): PromotionsPort => makePromotionsPort({ client: w.app, marketId: "EG", kill: promoKill, audit: new FakeAudit(), hmacKey: KEY, now: w.now, velocityPerHour: 1000 });

const addPromo = async (o: { storeId?: string | null; owner?: "platform" | "store"; type?: "fixed" | "percent" | "free_shipping"; level?: "order" | "store" | "shipping"; amount?: string; bps?: number; version?: number }): Promise<string> => {
  const id = randomUUID();
  const owner = o.owner ?? "platform";
  const discount = o.type === "free_shipping" ? { kind: "free_shipping" } : o.bps !== undefined ? { kind: "percent", bps: o.bps } : { kind: "fixed", amountMinor: o.amount ?? "10000" };
  await w.raw.query(
    `INSERT INTO promotions (id, market_id, owner_type, store_id, type, name_ar, rules, stacking_class, funding_platform_bp, funding_seller_bp, currency, starts_at, ends_at, status, version)
     VALUES ($1,'EG',$2,$3,$4,'عرض',$5::jsonb,'auto',$6,$7,'EGP','2029-12-01T00:00:00Z','2031-01-01T00:00:00Z','ACTIVE',$8)`,
    [id, owner, o.storeId ?? null, o.type ?? (o.bps === undefined ? "fixed" : "percent"), JSON.stringify({ level: o.level ?? "order", discount }), owner === "platform" ? 10_000 : 0, owner === "platform" ? 0 : 10_000, o.version ?? 1],
  );
  await w.raw.query("INSERT INTO promotion_usage (promotion_id, store_id, market_id, currency) VALUES ($1,$2,'EG','EGP')", [id, o.storeId ?? null]);
  return id;
};
const endAll = async (): Promise<void> => { await w.raw.query("UPDATE promotions SET status = 'ENDED'"); };
const redemptions = async (groupId: string): Promise<string[]> => (await w.raw.query<{ kind: string }>("SELECT kind FROM voucher_redemptions WHERE order_group_id = $1 ORDER BY kind", [groupId])).rows.map((r) => r.kind);
const usage = async (promoId: string): Promise<{ n: number; minor: string }> => {
  const r = (await w.raw.query<{ used_count: number; used_minor: string }>("SELECT used_count, used_minor::text FROM promotion_usage WHERE promotion_id = $1", [promoId])).rows[0];
  return { n: r?.used_count ?? -1, minor: r?.used_minor ?? "-1" };
};

beforeAll(async () => {
  w = await buildWorld();
});
afterAll(async () => { await w.close(); });
beforeEach(async () => {
  await endAll();
  promoKill.enabled = true;
  w.fakes.kill.engaged.clear();
  w.fakes.shipping.fees.clear();
  w.fakes.address.codEligible = true;
  w.fakes.provider.nextCreate = "requires_action";
  u = await w.newUser();
  skuA = await w.seedSku(w.stores[0], 100_000n, 20);
  skuB = await w.seedSku(w.stores[1], 50_000n, 20);
  w.fakes.shipping.fees.set(w.stores[0], 0n);
  w.fakes.shipping.fees.set(w.stores[1], 6000n);
});

const acct = (type: Parameters<typeof accountCode>[0]["type"], owner?: string): string => accountCode({ type, market: "EG", currency: "EGP", ...(owner === undefined ? {} : { owner }) });

describe("promotions in the quote", () => {
  it("no promotions port or an engaged kill switch: no discounts, plain quote (fail closed)", async () => {
    await addPromo({ amount: "10000" });
    await w.fillBag(u, [{ sku: skuA, qty: 1 }]);
    expect((await w.svc.quote(u, { addressRef: ADDR, method: "card" })).quote.discount.amountMinor).toBe(0n);
    const svc = w.makeSvc({}, { promotions: real() });
    expect((await svc.quote(u, { addressRef: ADDR, method: "card" })).quote.discount.amountMinor).toBe(10_000n);
    w.fakes.kill.engaged.add(PROMOTIONS_KILL_SWITCH);
    expect((await svc.quote(u, { addressRef: ADDR, method: "card" })).quote.discount.amountMinor).toBe(0n);
    w.fakes.kill.engaged.clear();
    promoKill.enabled = false; // the promotions module's own switch reads as disabled too
    expect((await svc.quote(u, { addressRef: ADDR, method: "card" })).quote.discount.amountMinor).toBe(0n);
  });

  it("an evaluator failure falls back to full price instead of failing the quote", async () => {
    const boom: PromotionsPort = { ...real(), evaluateForQuote: () => Promise.reject(new Error("db down")) };
    await w.fillBag(u, [{ sku: skuA, qty: 1 }]);
    const r = await w.makeSvc({}, { promotions: boom }).quote(u, { addressRef: ADDR, method: "card" });
    expect(r.quote.discount.amountMinor).toBe(0n);
  });

  it("shows only 'Voucher/Discount -X' labels (no percentage, no reference price); payable reflects the discount; the hash covers it", async () => {
    await addPromo({ bps: 1000, level: "order" });
    await w.fillBag(u, [{ sku: skuA, qty: 1 }, { sku: skuB, qty: 2 }]);
    const svc = w.makeSvc({}, { promotions: real() });
    const plain = await w.svc.quote(u, { addressRef: ADDR, method: "card" });
    const r = await svc.quote(u, { addressRef: ADDR, method: "card", voucherCodes: ["NOPE-NOPE"] });
    const q = r.quote;
    expect(r.invalidVoucherCodes).toEqual(["NOPE-NOPE"]);
    expect(q.discount.amountMinor).toBe(20_000n); // 10% of 200,000 goods
    expect(q.total.amountMinor).toBe(plain.quote.total.amountMinor - 20_000n);
    expect(q.payableByMethod.get("card")?.amountMinor).toBe(q.total.amountMinor);
    expect(q.discountLabels).toHaveLength(1);
    const label = q.discountLabels[0];
    expect(label?.textEn).toMatch(/^Discount −200\.00 EGP$/);
    expect(label?.textAr).toContain("خصم");
    expect(q.discountLabels.map((l) => `${l.textEn} ${l.textAr}`).join(" ")).not.toMatch(/%|bps|was/i);
    expect(q.verifiedSavings.amountMinor).toBe(0n);
    expect(q.hash).not.toBe(plain.quote.hash);
    const lineDisc = q.stores.flatMap((s) => s.lines).reduce((a, l) => a + l.platformDiscount.amountMinor + l.sellerDiscount.amountMinor, 0n);
    expect(lineDisc).toBe(20_000n);
    expect(q.stores.every((s) => s.lines.every((l) => l.payable.amountMinor === l.lineGross.amountMinor - l.platformDiscount.amountMinor - l.sellerDiscount.amountMinor))).toBe(true);
  });

  it("a free-delivery promotion waives the fee in the quote (store shipping discount) and the group total follows", async () => {
    await addPromo({ type: "free_shipping", level: "shipping" });
    await w.fillBag(u, [{ sku: skuB, qty: 1 }]);
    const plain = await w.svc.quote(u, { addressRef: ADDR, method: "card" });
    const q = (await w.makeSvc({}, { promotions: real() }).quote(u, { addressRef: ADDR, method: "card" })).quote;
    expect(q.discount.amountMinor).toBe(6000n);
    expect(q.stores[0]?.shippingDiscount.platform.amountMinor).toBe(6000n);
    expect(q.total.amountMinor).toBe(plain.quote.total.amountMinor - 6000n);
  });

  it("a promotion edited between quote and place changes the hash and takes the 409 price-changed path", async () => {
    const id = await addPromo({ amount: "10000" });
    await w.fillBag(u, [{ sku: skuA, qty: 1 }]);
    const svc = w.makeSvc({}, { promotions: real() });
    const q = await svc.quote(u, { addressRef: ADDR, method: "card" });
    await w.raw.query("UPDATE promotions SET version = version + 1 WHERE id = $1", [id]);
    const err = await svc.place(u, { addressRef: ADDR, method: "card", idempotencyKey: uuidv7(), quoteToken: q.token, quote: q.quote }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "price-changed", status: 409 });
    expect(JSON.stringify((err as { details?: { deltas?: unknown } }).details?.deltas ?? null)).toContain("promotions");
  });
});

describe("promotions in place, settlement and compensation", () => {
  const place = async (svc: ReturnType<World["makeSvc"]>, method: "card" | "cod" | "store_credit" = "card", key = uuidv7()) => {
    const q = await svc.quote(u, { addressRef: ADDR, method });
    return { q, key, res: await svc.place(u, { addressRef: ADDR, method, idempotencyKey: key, quoteToken: q.token, quote: q.quote }) };
  };

  it("ledger chart 4.2, platform-funded: seller paid as if full price, Dr promo_expense_platform (10,000), numbers reproduce the chart", async () => {
    const id = await addPromo({ amount: "10000" });
    w.fakes.commission.defaultBp = 1500;
    await w.fillBag(u, [{ sku: skuA, qty: 1 }]);
    const svc = w.makeSvc({}, { promotions: real() });
    const { res } = await place(svc);
    expect(await redemptions(res.orderGroupId)).toEqual(["reserved"]);
    expect(await usage(id)).toEqual({ n: 1, minor: "10000" });
    expect(await w.webhooks.handle(paidWebhook(w, await intentOf(w, res.orderGroupId), "pf-1"))).toMatchObject({ outcome: "processed" });
    const sellerRow = (await w.raw.query<{ seller_net_minor: string; commission_minor: string; commission_vat_minor: string; platform_discount_minor: string; seller_discount_minor: string; total_minor: string }>(
      "SELECT seller_net_minor::text, commission_minor::text, commission_vat_minor::text, platform_discount_minor::text, seller_discount_minor::text, total_minor::text FROM seller_orders WHERE order_group_id = $1", [res.orderGroupId])).rows[0];
    expect(sellerRow).toEqual({ seller_net_minor: "82900", commission_minor: "15000", commission_vat_minor: "2100", platform_discount_minor: "10000", seller_discount_minor: "0", total_minor: "90000" });
    const byCode = (await w.raw.query<{ code: string; amount: string }>(
      `SELECT a.code, p.amount_minor::text AS amount FROM journal_entries e JOIN postings p ON p.entry_id = e.id JOIN ledger_accounts a ON a.id = p.account_id WHERE e.idempotency_key = $1`, [`order_paid:${res.orderGroupId}`])).rows;
    const amt = (c: string): string | undefined => byCode.find((r) => r.code === c)?.amount;
    expect(amt(acct("psp_clearing", "paymob"))).toBe("90000");
    expect(amt(acct("promo_expense_platform"))).toBe("10000");
    expect(amt(acct("seller_pending", w.stores[0]))).toBe("-82900");
    expect(amt(acct("commission_revenue"))).toBe("-15000");
    expect(amt(acct("platform_vat_output"))).toBe("-2100");
    expect(byCode.reduce((a, r) => a + BigInt(r.amount), 0n)).toBe(0n);
    const tb = await w.raw.query<{ s: string }>("SELECT COALESCE(SUM(amount_minor), 0)::text AS s FROM postings");
    expect(tb.rows[0]?.s).toBe("0");
  });

  it("ledger chart 4.2, seller-funded: smaller seller share (74,610 / 13,500 / 1,890), no promo_expense_platform", async () => {
    await addPromo({ owner: "store", storeId: w.stores[0], level: "store", amount: "10000" });
    await w.fillBag(u, [{ sku: skuA, qty: 1 }]);
    const svc = w.makeSvc({}, { promotions: real() });
    const { res } = await place(svc);
    await w.webhooks.handle(paidWebhook(w, await intentOf(w, res.orderGroupId), "sf-1"));
    const byCode = (await w.raw.query<{ code: string; amount: string }>(
      `SELECT a.code, p.amount_minor::text AS amount FROM journal_entries e JOIN postings p ON p.entry_id = e.id JOIN ledger_accounts a ON a.id = p.account_id WHERE e.idempotency_key = $1`, [`order_paid:${res.orderGroupId}`])).rows;
    const amt = (c: string): string | undefined => byCode.find((r) => r.code === c)?.amount;
    expect(amt(acct("psp_clearing", "paymob"))).toBe("90000");
    expect(amt(acct("promo_expense_platform"))).toBeUndefined();
    expect(amt(acct("seller_pending", w.stores[0]))).toBe("-74610");
    expect(amt(acct("commission_revenue"))).toBe("-13500");
    expect(amt(acct("platform_vat_output"))).toBe("-1890");
    expect(byCode.reduce((a, r) => a + BigInt(r.amount), 0n)).toBe(0n);
    const line = (await w.raw.query<{ platform_discount_minor: string; seller_discount_minor: string }>("SELECT platform_discount_minor::text, seller_discount_minor::text FROM order_lines WHERE order_group_id = $1", [res.orderGroupId])).rows[0];
    expect(line).toEqual({ platform_discount_minor: "0", seller_discount_minor: "10000" });
  });

  it("webhook paid confirms the vouchers; failure and expiry release them (caps given back)", async () => {
    const id = await addPromo({ amount: "10000" });
    const promotions = real();
    const { webhooks, sweeper } = w.makeWorkers({ promotions });
    const svc = w.makeSvc({}, { promotions });
    await w.fillBag(u, [{ sku: skuA, qty: 1 }]);
    const paid = (await place(svc)).res.orderGroupId;
    await webhooks.handle(paidWebhook(w, await intentOf(w, paid), "cf-1"));
    expect(await redemptions(paid)).toEqual(["confirmed", "reserved"]);
    expect(await usage(id)).toEqual({ n: 1, minor: "10000" });

    const u2 = await w.newUser();
    await w.fillBag(u2, [{ sku: skuA, qty: 1 }]);
    u = u2;
    const expired = (await place(svc)).res.orderGroupId;
    expect(await usage(id)).toEqual({ n: 2, minor: "20000" });
    await w.raw.query("UPDATE order_groups SET payment_expires_at = now() - interval '1 minute' WHERE id = $1", [expired]);
    expect((await sweeper.run()).expired).toContain(expired);
    expect(await redemptions(expired)).toEqual(["released", "reserved"]);
    expect(await usage(id)).toEqual({ n: 1, minor: "10000" });
  });

  it("COD and store-credit placements confirm immediately; a COD refusal-style failure releases", async () => {
    const id = await addPromo({ amount: "10000" });
    const promotions = real();
    const svc = w.makeSvc({}, { promotions });
    await w.fillBag(u, [{ sku: skuA, qty: 1 }]);
    const cod = (await place(svc, "cod")).res;
    expect(cod.status).toBe("CONFIRMED_COD");
    expect(await redemptions(cod.orderGroupId)).toEqual(["confirmed", "reserved"]);

    const u3 = await w.newUser();
    await w.grantCredit(u3, 500_000n);
    u = u3;
    await w.fillBag(u3, [{ sku: skuA, qty: 1 }]);
    const sc = (await place(svc, "store_credit")).res;
    expect(sc.status).toBe("PAID");
    expect(await redemptions(sc.orderGroupId)).toEqual(["confirmed", "reserved"]);
    expect((await usage(id)).n).toBe(2);
  });

  it("COD awaiting confirmation keeps the reservation; confirmCod confirms", async () => {
    await addPromo({ amount: "10000" });
    w.fakes.risk.decision = "require_confirmation";
    try {
      const svc = w.makeSvc({}, { promotions: real() });
      await w.fillBag(u, [{ sku: skuA, qty: 1 }]);
      const r = (await place(svc, "cod")).res;
      expect(r.status).toBe("AWAITING_COD_CONFIRMATION");
      expect(await redemptions(r.orderGroupId)).toEqual(["reserved"]);
      await svc.confirmCod(u, r.orderGroupId);
      expect(await redemptions(r.orderGroupId)).toEqual(["confirmed", "reserved"]);
      // a group without a discount never touches the voucher service
      const plain = await w.newUser();
      await endAll();
      await w.fillBag(plain, [{ sku: skuB, qty: 1 }]);
      const q = await svc.quote(plain, { addressRef: ADDR, method: "cod" });
      const p = await svc.place(plain, { addressRef: ADDR, method: "cod", idempotencyKey: uuidv7(), quoteToken: q.token, quote: q.quote });
      await svc.confirmCod(plain, p.orderGroupId);
      expect(await redemptions(p.orderGroupId)).toEqual([]);
    } finally {
      w.fakes.risk.decision = "allow";
    }
  });

  it("a PSP decline releases the vouchers; the idempotent replay does not reserve twice", async () => {
    const id = await addPromo({ amount: "10000" });
    const svc = w.makeSvc({}, { promotions: real() });
    await w.fillBag(u, [{ sku: skuA, qty: 1 }]);
    w.fakes.provider.nextCreate = "decline";
    const q = await svc.quote(u, { addressRef: ADDR, method: "card" });
    const key = uuidv7();
    expect(await errCode(svc.place(u, { addressRef: ADDR, method: "card", idempotencyKey: key, quoteToken: q.token, quote: q.quote }))).toBe("payment-declined");
    expect(await usage(id)).toEqual({ n: 0, minor: "0" });
    w.fakes.provider.nextCreate = "requires_action";
    // replay the (now compensated) key: no new reservation row is written
    const before = (await w.raw.query("SELECT 1 FROM voucher_redemptions")).rows.length;
    await svc.place(u, { addressRef: ADDR, method: "card", idempotencyKey: key, quoteToken: q.token, quote: q.quote }).catch(() => undefined);
    expect((await w.raw.query("SELECT 1 FROM voucher_redemptions")).rows.length).toBe(before);
  });

  it("a reservation that fails at place (cap hit after the quote) refuses with price-changed and leaves nothing behind", async () => {
    const id = await addPromo({ amount: "10000" });
    const failing: PromotionsPort = { ...real(), reserve: () => Promise.reject(new Error("CAP_EXCEEDED")) };
    await w.fillBag(u, [{ sku: skuA, qty: 1 }]);
    const svc = w.makeSvc({}, { promotions: failing });
    const q = await svc.quote(u, { addressRef: ADDR, method: "card" });
    expect(await errCode(svc.place(u, { addressRef: ADDR, method: "card", idempotencyKey: uuidv7(), quoteToken: q.token, quote: q.quote }))).toBe("price-changed");
    expect(await usage(id)).toEqual({ n: 0, minor: "0" });
    expect((await w.raw.query("SELECT 1 FROM order_groups WHERE user_id = $1", [u])).rows).toHaveLength(0);
  });

  it("a failure inside the order transaction releases the reservation (saga compensation)", async () => {
    const id = await addPromo({ amount: "10000" });
    const lacking = new Proxy(w.reservations, { get: (t, p, r) => (p === "reserveIn" ? () => Promise.resolve({ ok: false as const, shortfalls: [] }) : (Reflect.get(t, p, r) as unknown)) });
    await w.fillBag(u, [{ sku: skuA, qty: 1 }]);
    const svc = w.makeSvc({}, { promotions: real(), reservations: lacking });
    const q = await svc.quote(u, { addressRef: ADDR, method: "card" });
    expect(await errCode(svc.place(u, { addressRef: ADDR, method: "card", idempotencyKey: uuidv7(), quoteToken: q.token, quote: q.quote }))).toBe("stock-shortfall");
    expect(await usage(id)).toEqual({ n: 0, minor: "0" });
  });

  it("two taps with the same key: one order, the loser's spare reservation is released", async () => {
    const id = await addPromo({ amount: "10000" });
    const svc = w.makeSvc({}, { promotions: real() });
    await w.fillBag(u, [{ sku: skuA, qty: 1 }]);
    const q = await svc.quote(u, { addressRef: ADDR, method: "card" });
    const key = uuidv7();
    const go = () => svc.place(u, { addressRef: ADDR, method: "card", idempotencyKey: key, quoteToken: q.token, quote: q.quote });
    const [a, b] = await Promise.all([go(), go()]);
    expect(a.orderGroupId).toBe(b.orderGroupId);
    expect(await usage(id)).toEqual({ n: 1, minor: "10000" });
  });

  it("promotion settlement failures never fail a paid order (reservation keeps counting)", async () => {
    const id = await addPromo({ amount: "10000" });
    const flaky: PromotionsPort = { ...real(), confirm: () => Promise.reject(new Error("down")), release: () => Promise.reject(new Error("down")) };
    const svc = w.makeSvc({}, { promotions: flaky });
    const { webhooks } = w.makeWorkers({ promotions: flaky });
    await w.fillBag(u, [{ sku: skuA, qty: 1 }]);
    const g = (await place(svc)).res.orderGroupId;
    expect(await webhooks.handle(paidWebhook(w, await intentOf(w, g), "fl-1"))).toMatchObject({ outcome: "processed" });
    expect(await usage(id)).toEqual({ n: 1, minor: "10000" });
  });

  it("a payment whose stock is gone (reservation lapsed, last unit sold) is refunded and the vouchers are released", async () => {
    const id = await addPromo({ amount: "10000" });
    const promotions = real();
    const svc = w.makeSvc({}, { promotions });
    const { webhooks } = w.makeWorkers({ promotions });
    const last = await w.seedSku(w.stores[2], 40_000n, 1);
    await w.fillBag(u, [{ sku: last, qty: 1 }]);
    const g = (await place(svc)).res.orderGroupId;
    const intent = await intentOf(w, g);
    expect(await usage(id)).toEqual({ n: 1, minor: "10000" });
    w.clock.t += 11 * 60_000;
    await w.reservations.sweepExpired(new Date(w.clock.t));
    const other = await w.newUser();
    await w.fillBag(other, [{ sku: last, qty: 1 }]);
    expect((await w.svc.quote(other, { addressRef: ADDR, method: "cod" })).quote.stores).toHaveLength(1);
    const q = await w.svc.quote(other, { addressRef: ADDR, method: "cod" });
    await w.svc.place(other, { addressRef: ADDR, method: "cod", idempotencyKey: uuidv7(), quoteToken: q.token, quote: q.quote });
    expect(await webhooks.handle(paidWebhook(w, intent, "gone-1"))).toMatchObject({ outcome: "processed", detail: "late_refund" });
    expect(await redemptions(g)).toEqual(["released", "reserved"]);
    expect(await usage(id)).toEqual({ n: 0, minor: "0" });
  });

  it("a payment that arrives after expiry does not resurrect the released vouchers (documented limitation: the discount stands, the caps are not re-taken)", async () => {
    const id = await addPromo({ amount: "10000" });
    const promotions = real();
    const svc = w.makeSvc({}, { promotions });
    const { webhooks, sweeper } = w.makeWorkers({ promotions });
    await w.fillBag(u, [{ sku: skuA, qty: 1 }]);
    const g = (await place(svc)).res.orderGroupId;
    await w.raw.query("UPDATE order_groups SET payment_expires_at = now() - interval '1 minute' WHERE id = $1", [g]);
    expect((await sweeper.run()).expired).toContain(g);
    await webhooks.handle(paidWebhook(w, await intentOf(w, g), "late-1"));
    expect(await redemptions(g)).toEqual(["released", "reserved"]);
    expect(await usage(id)).toEqual({ n: 0, minor: "0" });
  });
});

describe("address: snapshot per seller order, geo area for shipping, COD eligibility", () => {
  it("snapshots every seller order after the commit with the placed address; a replay repeats it idempotently; the shipping port gets the geo area", async () => {
    const snaps = new FakeAddressSnapshots();
    const svc = w.makeSvc({}, { addressSnapshots: snaps });
    await w.fillBag(u, [{ sku: skuA, qty: 1 }, { sku: skuB, qty: 1 }]);
    const before = w.fakes.shipping.requests.length;
    const q = await svc.quote(u, { addressRef: ADDR, method: "card" });
    expect(w.fakes.shipping.requests.slice(before).every((r) => r.geoAreaId === "00000000-0000-4000-8000-0000000000aa" && r.addressRef === ADDR)).toBe(true);
    const key = uuidv7();
    const input = { addressRef: ADDR, method: "card" as const, idempotencyKey: key, quoteToken: q.token, quote: q.quote };
    const res = await svc.place(u, input);
    expect(snaps.calls).toHaveLength(2);
    expect(snaps.calls.every((c) => c.userId === u && c.addressId === ADDR)).toBe(true);
    const orders = (await w.raw.query<{ id: string }>("SELECT id FROM seller_orders WHERE order_group_id = $1", [res.orderGroupId])).rows.map((r) => r.id).sort();
    expect(snaps.calls.map((c) => c.sellerOrderId).sort()).toEqual(orders);
    await svc.place(u, input);
    expect(snaps.calls).toHaveLength(4);
  });

  it("a snapshot failure surfaces (the order exists; the same key retries)", async () => {
    const snaps = new FakeAddressSnapshots();
    const svc = w.makeSvc({}, { addressSnapshots: snaps });
    await w.fillBag(u, [{ sku: skuB, qty: 1 }]);
    const q = await svc.quote(u, { addressRef: ADDR, method: "card" });
    const input = { addressRef: ADDR, method: "card" as const, idempotencyKey: uuidv7(), quoteToken: q.token, quote: q.quote };
    snaps.failWith = new Error("address gone");
    await expect(svc.place(u, input)).rejects.toThrow("address gone");
    snaps.failWith = null;
    expect((await svc.place(u, input)).replayed).toBe(true);
    expect(snaps.calls).toHaveLength(1);
  });

  it("COD eligibility comes from the address: the quote says why and placement refuses", async () => {
    await w.fillBag(u, [{ sku: skuB, qty: 1 }]);
    w.fakes.address.codEligible = false;
    const q = await w.svc.quote(u, { addressRef: ADDR, method: "card" });
    expect(q.cod).toEqual({ allowed: false, reasonCode: "cod_address_ineligible" });
    const qc = await w.svc.quote(u, { addressRef: ADDR, method: "cod" });
    expect(await errCode(w.svc.place(u, { addressRef: ADDR, method: "cod", idempotencyKey: uuidv7(), quoteToken: qc.token, quote: qc.quote }))).toBe("cod-not-allowed");
    w.fakes.address.codEligible = true;
    expect((await w.svc.quote(u, { addressRef: ADDR, method: "card" })).cod.allowed).toBe(true);
  });

  it("quoteAndPlace helper still works end to end without promotions", async () => {
    await w.fillBag(u, [{ sku: skuB, qty: 1 }]);
    const r = await quoteAndPlace(w, u, "card");
    expect((await r.place()).status).toBe("PENDING_PAYMENT");
  });
});
