/**
 * Adversarial audit of Phase 1 wave 4 (money core). Every test here encodes a CONFIRMED defect and is
 * expected to FAIL against the current source. Do not weaken them; fix the source instead.
 *
 *   ADV-W4-1  store credit: the checkout hold (10 min) can be released by the sweeper while a wallet or
 *             Fawry payment is still legitimately open; capture then silently no-ops, so the credit is
 *             recognised in the ledger as spent but is still spendable
 *   ADV-W4-2  store credit (in-memory reference store): placeHold is a check-then-act race, so two
 *             concurrent holds for different refs spend the same lot twice
 *   ADV-W4-3  refunds: intake has no cumulative cap, so two return intents for the same seller order
 *             (different return ids) each refund the whole tender
 *   ADV-W4-4  reconciliation: a provider file that re-reports already-settled references under a new
 *             settlement id matches the same internal lines a second time and raises no finding
 *   ADV-W4-5  payouts: send() posts the ledger entry before its version check, so a cancel that wins the
 *             race leaves a live payout entry on a CANCELLED payout whose lines are paid again next cycle
 */
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CART_CATALOG, type FakeCatalog } from "./modules/cart";
import { CHECKOUT_CONTEXT, CHECKOUT_WEBHOOK, type CheckoutContext, type FakeAddresses, type HandlePaymentWebhook } from "./modules/checkout";
import { INVENTORY_SKU_DIRECTORY, INVENTORY_SYNC_STOCK, type InMemorySkuDirectory, type SyncSellerStock } from "./modules/inventory";
import { PAYMENT_STORE, type PaymentStore } from "./modules/payments";
import { CREDIT_HOLDS, GRANT_CREDIT, STORE_CREDIT_STORE, CreditHolds, InMemoryStoreCredit, type GrantCredit, type StoreCreditStore } from "./modules/store-credit";
import { createHarness, login, type Harness } from "./test/harness";
import { COMMERCE_TERMS_REGISTRY, type RegisteredCommerceTerms } from "./composition/money-wiring";
import { Late } from "./composition/late";
import { PaymentEventsToCheckout } from "./composition/money-adapters";
import { money } from "./composition/domain";
import { createIdGenerator, nodeCsprng } from "./platform";
import { FakeCreditRestore, FakePayoutDetails, FakeRefundExecutor, FakeRefundFacts, InMemoryRefundLedger, SeqJitter } from "./modules/refunds/adapters/fakes";
import { InMemoryRefundStore } from "./modules/refunds/adapters/in-memory";
import { IntakeRefundIntent } from "./modules/refunds/application/intake";
import { SELLER_ORDER_1, SeqIds, TestClock as RefundClock, facts, intent, tender } from "./modules/refunds/test/fixtures";
import { InMemoryReconStore } from "./modules/reconciliation/adapters/in-memory";
import { InMemoryPayoutStore } from "./modules/payouts/adapters/in-memory";
import { FINANCE_1, STORE_A as PAYOUT_STORE_A, TestClock as PayoutClock, addOrder, kit as payoutKit, seedStore } from "./modules/payouts/test/fixtures";
import { DAY, T0 as RECON_T0, TestClock as ReconClock, csv, kit } from "./modules/reconciliation/test/fixtures";

const uid = (n: number): string => `0192f3a4-5b6c-7d8e-9f12-${String(n).padStart(12, "0")}`;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("ADV-W4-1 store credit hold must outlive the payment window it protects", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h.close());

  it("a mobile-wallet checkout paid after the hold TTL and a sweep still consumes the credit", async () => {
    const STORE = uid(1);
    const SKU = uid(2);
    const PRODUCT = uid(3);
    const LOCATION = uid(4);
    const ADDRESS = uid(5);
    const user = await login(h, "+201009990042");

    const catalog = h.app.get<FakeCatalog>(CART_CATALOG, { strict: false });
    catalog.addStore(STORE);
    // Fixture update after review F-4: commission is fail-closed, so the store needs agreed terms.
    h.app.get<RegisteredCommerceTerms>(COMMERCE_TERMS_REGISTRY, { strict: false }).register(STORE, 1500);
    catalog.addSku({
      skuId: SKU,
      productId: PRODUCT,
      storeId: STORE,
      title: { ar: "قميص" },
      unitPrice: { amount: 150_000n, currency: "EGP" },
      available: true,
    });
    h.app.get<InMemorySkuDirectory>(INVENTORY_SKU_DIRECTORY, { strict: false }).register(SKU, { storeId: STORE, locationId: LOCATION, dropId: null });
    await h.app.get<SyncSellerStock>(INVENTORY_SYNC_STOCK, { strict: false }).execute({
      skuId: SKU,
      actorStoreIds: [STORE],
      actorId: "seller-1",
      actorType: "seller",
      mode: "set",
      quantity: 5,
      reason: "received",
      idempotencyKey: "adv-w4-stock",
    });
    (h.app.get<CheckoutContext>(CHECKOUT_CONTEXT, { strict: false }).addresses as FakeAddresses).add(user.userId, ADDRESS);

    const credit = 40_000n;
    await h.app.get<GrantCredit>(GRANT_CREDIT, { strict: false }).promo({
      userId: user.userId,
      sub: { kind: "goodwill" },
      amount: money(credit),
      key: "adv-w4-goodwill",
    });
    const lotsBefore = await h.app.get<StoreCreditStore>(STORE_CREDIT_STORE, { strict: false }).listLots(user.userId);
    expect(lotsBefore.reduce((a, l) => a + l.remaining, 0n)).toBe(credit);

    const add = await h.http().post("/v1/cart/lines").set(bearer(user.accessToken)).set("Idempotency-Key", uid(11)).send({ sku_id: SKU, qty: 1 });
    expect(add.status).toBe(201);
    const placed = await h
      .http()
      .post("/v1/checkout")
      .set(bearer(user.accessToken))
      .set("Idempotency-Key", uid(12))
      .send({ method: "mobile_wallet", address_id: ADDRESS, use_store_credit: true });
    expect(placed.status, JSON.stringify(placed.body)).toBeLessThan(300);
    const groupId = String(placed.body.order_group_id);

    // The shopper is still inside the 30 minute wallet window; the 10 minute credit hold has lapsed.
    h.clock.advance(11 * 60_000);
    await h.app.get<CreditHolds>(CREDIT_HOLDS, { strict: false }).sweepExpired();

    const intent = await h.app.get<PaymentStore>(PAYMENT_STORE, { strict: false }).getIntentByOrderGroup(groupId);
    if (intent === null) throw new Error("intent missing");
    const late = new Late<HandlePaymentWebhook>("adv");
    late.bind(h.app.get<HandlePaymentWebhook>(CHECKOUT_WEBHOOK, { strict: false }));
    await new PaymentEventsToCheckout(late).handle({
      id: uid(900),
      type: "payment.succeeded",
      occurredAtMs: h.clock.nowMs(),
      payload: { intent_id: intent.id, order_group_id: groupId, amount: intent.amount.toString(), currency: "EGP", provider: intent.provider },
    });
    const fresh = await login(h, "+201009990042");
    const state = await h.http().get(`/v1/checkout/${groupId}`).set(bearer(fresh.accessToken));
    expect(state.body.status).toBe("placed");

    // The order was recognised as paid partly with store credit, so the lots must have been drawn down.
    const lotsAfter = await h.app.get<StoreCreditStore>(STORE_CREDIT_STORE, { strict: false }).listLots(user.userId);
    expect(lotsAfter.reduce((a, l) => a + l.remaining, 0n)).toBe(0n);
  });
});

describe("ADV-W4-2 store credit holds must be atomic per user", () => {
  it("two concurrent holds for different refs cannot both take the same 1,000 piastres", async () => {
    const clock = { nowMs: () => 1_800_000_000_000 };
    const ids = createIdGenerator(clock, nodeCsprng);
    const store = new InMemoryStoreCredit();
    await store.addLot({
      lot: { id: uid(21), userId: uid(20), sub: { kind: "goodwill" }, granted: 1_000n, remaining: 1_000n, held: 0n, expiresAtMs: null, createdAtMs: clock.nowMs(), sourceKey: "lot-1" },
      txn: { id: uid(22), userId: uid(20), kind: "credit_added", reason: "goodwill", sub: { kind: "goodwill" }, amount: 1_000n, ref: "lot-1", dedupeKey: "added:lot-1", createdAtMs: clock.nowMs() },
    });
    const holds = new CreditHolds(store, ids, clock);
    const [a, b] = await Promise.all([
      holds.hold({ userId: uid(20), ref: "hold:A", amount: money(1_000n) }),
      holds.hold({ userId: uid(20), ref: "hold:B", amount: money(1_000n) }),
    ]);
    const held = [a, b].filter((r) => r.kind === "held").length;
    expect(held).toBe(1);
    const lots = await store.listLots(uid(20));
    expect(lots.every((l) => l.held <= l.remaining)).toBe(true);
  });
});

describe("ADV-W4-3 refund intake must cap cumulative refunds at what the tender can still refund", () => {
  it("a second return intent for the same seller order, under another return id, is not created", async () => {
    const clock = new RefundClock();
    const store = new InMemoryRefundStore();
    const factsPort = new FakeRefundFacts();
    factsPort.seed(SELLER_ORDER_1, facts([tender("t1", "card", 10_000n)]));
    const intake = new IntakeRefundIntent(store, factsPort, new SeqIds(), clock);
    const first = await intake.execute(intent(1, { net: 10_000n }));
    expect(first.kind).toBe("created");
    const second = await intake.execute(intent(2, { net: 10_000n }));
    expect(second.kind).not.toBe("created");
    // Sanity on what a double refund would have been: more than was ever paid.
    const total = [...(await Promise.all([first, second].map(async (r) => (r.kind === "created" ? (await store.get(r.refundId))?.amount ?? 0n : 0n))))].reduce((a, b) => a + b, 0n);
    expect(total).toBeLessThanOrEqual(10_000n);
    // Keep the unused fakes referenced so the world matches the module's own tests.
    void [FakeCreditRestore, FakePayoutDetails, FakeRefundExecutor, InMemoryRefundLedger, SeqJitter];
  });
});

describe("ADV-W4-4 reconciliation must not match one internal line from two settlement files", () => {
  it("re-reported references under a new settlement id raise a finding", async () => {
    const BASE = RECON_T0 - 2 * DAY;
    const clock = new ReconClock();
    const store = new InMemoryReconStore();
    const k = kit(store, clock);
    const lines = [
      { no: 1, ref: "ref-1", gross: 10_000n, fee: 250n, at: BASE },
      { no: 2, ref: "ref-2", gross: 5_000n, fee: 125n, at: BASE + 1_000 },
    ];
    for (const id of ["S1", "S2"]) {
      const r = await k.ingest.execute({ kind: "psp", provider: "fakepay", format: "fixture_csv_v1", content: csv(id, lines) });
      expect(r.kind).toBe("stored");
    }
    // The ledger knows each reference once, and both settlements are posted for the same totals.
    k.clearing.addLine("psp", "fakepay", { id: "l1", key: "ref-1", amount: 10_000n, atMs: BASE });
    k.clearing.addLine("psp", "fakepay", { id: "l2", key: "ref-2", amount: 5_000n, atMs: BASE + 1_000 });
    k.clearing.post("psp", "fakepay", "S1", 15_000n, 375n);
    k.clearing.post("psp", "fakepay", "S2", 15_000n, 375n);
    const run = await k.runner.execute("nightly");
    expect(run.kind).toBe("completed");
    if (run.kind === "completed") expect(run.findings).toBeGreaterThan(0);
  });
});

describe("ADV-W4-5 a payout send racing a cancel must not leave a live ledger entry", () => {
  it("cancel wins the version check: the payout entry posted by send is reversed or never posted", async () => {
    const clock = new PayoutClock();
    const store = new InMemoryPayoutStore(clock);
    const k = payoutKit(store, clock);
    seedStore(k, PAYOUT_STORE_A);
    addOrder(k, 1, 80_000n);
    await k.commands.schedule();
    const page = await store.list({ scope: { kind: "system" }, storeId: PAYOUT_STORE_A, after: null, limit: 10 });
    const p = page.items[0];
    if (p === undefined) throw new Error("no payout scheduled");
    expect((await k.commands.approve({ payoutId: p.id, actor: { id: FINANCE_1 }, key: "ap" })).kind).toBe("ok");
    k.provider.mode = "settle";

    await Promise.all([k.commands.send(p.id), k.commands.cancel({ payoutId: p.id, actor: { id: FINANCE_1 }, key: "c" })]);

    const after = await store.get(p.id, { kind: "system" });
    expect(after?.status).toBe("CANCELLED");
    expect(k.provider.executed).toHaveLength(0);
    // Nothing was paid out, so the seller's payable must be untouched: no live payout entry.
    expect(k.ledger.entries.size - k.ledger.reversals.size).toBe(0);
  });
});
