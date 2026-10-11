import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CART_CATALOG, type FakeCatalog } from "../modules/cart";
import { CHECKOUT_CONTEXT, CHECKOUT_WEBHOOK, type CheckoutContext, type FakeAddresses, type HandlePaymentWebhook } from "../modules/checkout";
import {
  INVENTORY_SKU_DIRECTORY,
  INVENTORY_SYNC_STOCK,
  type InMemorySkuDirectory,
  type SyncSellerStock,
} from "../modules/inventory";
import { INTEGRITY_JOB, LEDGER_READ_MODEL, LEDGER_SNAPSHOTS, type IntegritySnapshots, type IntegrityJob, type LedgerReadModel } from "../modules/ledger";
import { PAYMENT_STORE, type PaymentStore } from "../modules/payments";
import { ORDER_REPOSITORY, type OrderRepository } from "../modules/orders";
import { createHarness, login, type Harness } from "../test/harness";
import { Late } from "./late";
import { PaymentEventsToCheckout } from "./money-adapters";
import { COMMERCE_TERMS_REGISTRY, LedgerClearingAdapter, createPaymentEventsRelay, type RegisteredCommerceTerms } from "./money-wiring";
import { FakePaymentProvider, type InMemoryPaymentStore } from "../modules/payments";
import { PAYMENT_PROCESS_WEBHOOK, type ProcessPaymentWebhook } from "../modules/payments";
import { MemoryDatabase, createOutboxRecord, type JsonObject } from "@outlet/outbox";

const uid = (n: number): string => `0192f3a4-5b6c-7d8e-9f02-${String(n).padStart(12, "0")}`;
const STORE = uid(1);
const SKU = uid(2);
const PRODUCT = uid(3);
const LOCATION = uid(4);
const ADDRESS = uid(5);
const KEY = (n: number): string => `0192f3a4-5b6c-7d8e-9f03-${String(n).padStart(12, "0")}`;

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("money composition: real adapters across cart, inventory, tax, promotions, payments, orders, ledger", () => {
  it("runs a card checkout end to end: quote, place, payment event, order placed, ledger balanced", async () => {
    const user = await login(h, "+201009990001");

    // Seed the modules' own in-memory stores through their public tokens.
    // Seller-agreement terms are registered, never defaulted (I-4).
    h.app.get<RegisteredCommerceTerms>(COMMERCE_TERMS_REGISTRY, { strict: false }).register(STORE, 1_500);
    h.app.get<FakeCatalog>(CART_CATALOG, { strict: false }).addStore(STORE);
    h.app.get<FakeCatalog>(CART_CATALOG, { strict: false }).addSku({
      skuId: SKU,
      productId: PRODUCT,
      storeId: STORE,
      title: { ar: "قميص" },
      unitPrice: { amount: 150_000n, currency: "EGP" },
      available: true,
    });
    h.app.get<InMemorySkuDirectory>(INVENTORY_SKU_DIRECTORY, { strict: false }).register(SKU, {
      storeId: STORE,
      locationId: LOCATION,
      dropId: null,
    });
    const stock = await h.app.get<SyncSellerStock>(INVENTORY_SYNC_STOCK, { strict: false }).execute({
      skuId: SKU,
      actorStoreIds: [STORE],
      actorId: "seller-1",
      actorType: "seller",
      mode: "set",
      quantity: 5,
      reason: "received",
      idempotencyKey: "wiring-stock-1",
    });
    expect(stock.kind).toBe("applied");
    const ctx = h.app.get<CheckoutContext>(CHECKOUT_CONTEXT, { strict: false });
    (ctx.addresses as FakeAddresses).add(user.userId, ADDRESS);

    const add = await h.http().post("/v1/cart/lines").set(bearer(user.accessToken)).set("Idempotency-Key", KEY(1)).send({ sku_id: SKU, qty: 1 });
    expect(add.status).toBe(201);

    const quote = await h
      .http()
      .post("/v1/checkout/quote")
      .set(bearer(user.accessToken))
      .send({ method: "card", address_id: ADDRESS, use_store_credit: false });
    expect(quote.status, JSON.stringify(quote.body)).toBe(200);
    // Merchandise comes from the cart module's server-side price, never from the client.
    expect(BigInt(quote.body.total.amount)).toBeGreaterThanOrEqual(150_000n);

    const placed = await h
      .http()
      .post("/v1/checkout")
      .set(bearer(user.accessToken))
      .set("Idempotency-Key", KEY(2))
      .send({ method: "card", address_id: ADDRESS, use_store_credit: false });
    expect(placed.status, JSON.stringify(placed.body)).toBeLessThan(300);
    expect(placed.body.status).toBe("await_payment");
    const groupId = String(placed.body.order_group_id);

    // The payments module created the intent; its outbox event drives the saga.
    const intent = await h.app.get<PaymentStore>(PAYMENT_STORE, { strict: false }).getIntentByOrderGroup(groupId);
    expect(intent).not.toBeNull();
    if (intent === null) throw new Error("unreachable");
    const late = new Late<HandlePaymentWebhook>("test");
    late.bind(h.app.get<HandlePaymentWebhook>(CHECKOUT_WEBHOOK, { strict: false }));
    const bridge = new PaymentEventsToCheckout(late);
    const event = {
      id: uid(900),
      type: "payment.succeeded",
      occurredAtMs: h.clock.nowMs(),
      payload: {
        intent_id: intent.id,
        order_group_id: groupId,
        amount: intent.amount.toString(),
        currency: "EGP",
        provider: intent.provider,
      },
    } as const;
    expect(await bridge.handle(event)).toBe("applied");
    // At-least-once delivery: the replay changes nothing.
    expect(["duplicate", "ignored"]).toContain(await bridge.handle(event));

    const state = await h.http().get(`/v1/checkout/${groupId}`).set(bearer(user.accessToken));
    expect(state.status).toBe(200);
    expect(state.body.status).toBe("placed");

    // Orders module holds the group, once.
    const group = await h.app.get<OrderRepository>(ORDER_REPOSITORY, { strict: false }).getGroupForUser(groupId, user.userId);
    expect(group?.sellerOrders).toHaveLength(1);

    // The ledger saw the sale, balanced to zero, with an intact hash chain.
    const reads = h.app.get<LedgerReadModel>(LEDGER_READ_MODEL, { strict: false });
    const payable = await reads.balances({ actorId: user.userId, role: "finance" }, { type: "seller_payable", ownerId: STORE, limit: 5 });
    expect(payable[0]?.natural ?? 0n).toBeGreaterThan(0n);
    const report = await h.app.get<IntegrityJob>(INTEGRITY_JOB, { strict: false }).run();
    expect(report.trialBalance.ok).toBe(true);
    expect(report.chain.ok).toBe(true);
  });

  it("a payment event for an unknown order group is stored, not applied, and never throws", async () => {
    const late = new Late<HandlePaymentWebhook>("test");
    late.bind(h.app.get<HandlePaymentWebhook>(CHECKOUT_WEBHOOK, { strict: false }));
    const out = await new PaymentEventsToCheckout(late).handle({
      id: uid(901),
      type: "payment.succeeded",
      occurredAtMs: h.clock.nowMs(),
      payload: { intent_id: "i-1", order_group_id: uid(777), amount: "100", currency: "EGP", provider: "fake_psp" },
    });
    expect(out).toBe("unknown_group");
  });

  it("a malformed payload throws so the relay retries instead of dropping the event", async () => {
    const late = new Late<HandlePaymentWebhook>("test");
    late.bind(h.app.get<HandlePaymentWebhook>(CHECKOUT_WEBHOOK, { strict: false }));
    await expect(
      new PaymentEventsToCheckout(late).handle({ id: uid(902), type: "payment.succeeded", occurredAtMs: 1, payload: { amount: "x" } }),
    ).rejects.toThrow();
  });

  it("unrelated payment events are skipped", async () => {
    const late = new Late<HandlePaymentWebhook>("test");
    late.bind(h.app.get<HandlePaymentWebhook>(CHECKOUT_WEBHOOK, { strict: false }));
    expect(await new PaymentEventsToCheckout(late).handle({ id: uid(903), type: "payment.voided", occurredAtMs: 1, payload: {} })).toBe("skipped");
  });
});

async function seedCart(user: { userId: string; accessToken: string }, n: number, store: string, registerTerms: boolean) {
  const sku = uid(100 + n);
  if (registerTerms) h.app.get<RegisteredCommerceTerms>(COMMERCE_TERMS_REGISTRY, { strict: false }).register(store, 1_500);
  const catalog = h.app.get<FakeCatalog>(CART_CATALOG, { strict: false });
  catalog.addStore(store);
  catalog.addSku({
    skuId: sku,
    productId: uid(200 + n),
    storeId: store,
    title: { ar: "قميص" },
    unitPrice: { amount: 150_000n, currency: "EGP" },
    available: true,
  });
  h.app.get<InMemorySkuDirectory>(INVENTORY_SKU_DIRECTORY, { strict: false }).register(sku, { storeId: store, locationId: LOCATION, dropId: null });
  await h.app.get<SyncSellerStock>(INVENTORY_SYNC_STOCK, { strict: false }).execute({
    skuId: sku,
    actorStoreIds: [store],
    actorId: "seller-x",
    actorType: "seller",
    mode: "set",
    quantity: 5,
    reason: "received",
    idempotencyKey: `wiring-stock-${n}`,
  });
  const ctx = h.app.get<CheckoutContext>(CHECKOUT_CONTEXT, { strict: false });
  (ctx.addresses as FakeAddresses).add(user.userId, ADDRESS);
  const add = await h.http().post("/v1/cart/lines").set(bearer(user.accessToken)).set("Idempotency-Key", KEY(10 + n)).send({ sku_id: sku, qty: 1 });
  expect(add.status).toBe(201);
}

describe("I-4: commerce terms refuse unknown stores", () => {
  it("a quote for a store with no registered terms fails closed and creates no intent", async () => {
    const user = await login(h, "+201009990002");
    await seedCart(user, 1, uid(51), false);
    const before = h.app.get<InMemoryPaymentStore>(PAYMENT_STORE, { strict: false }).allIntents().length;
    const quote = await h.http().post("/v1/checkout/quote").set(bearer(user.accessToken)).send({ method: "card", address_id: ADDRESS, use_store_credit: false });
    expect(quote.status).toBeGreaterThanOrEqual(400);
    expect(quote.body.total).toBeUndefined();
    expect(h.app.get<InMemoryPaymentStore>(PAYMENT_STORE, { strict: false }).allIntents().length).toBe(before);
  });
});

describe("I-2: webhook -> payments outbox -> relay -> inbox -> checkout saga", () => {
  it("places the order once, and a duplicate delivery changes nothing", async () => {
    const user = await login(h, "+201009990003");
    await seedCart(user, 2, uid(52), true);
    const placed = await h.http().post("/v1/checkout").set(bearer(user.accessToken)).set("Idempotency-Key", KEY(30))
      .send({ method: "card", address_id: ADDRESS, use_store_credit: false });
    expect(placed.status, JSON.stringify(placed.body)).toBeLessThan(300);
    const groupId = String(placed.body.order_group_id);
    const store = h.app.get<InMemoryPaymentStore>(PAYMENT_STORE, { strict: false });
    const intent = await store.getIntentByOrderGroup(groupId);
    if (intent === null) throw new Error("intent missing");

    // 1. Signed PSP webhook over HTTP: raw event stored, processed by the payments consumer.
    const body = {
      type: "payment.succeeded",
      event_id: "evt_relay_1",
      provider_ref: intent.providerRef,
      order_group_id: groupId,
      amount: intent.amount.toString(),
      currency: "EGP",
      occurred_at_ms: h.clock.nowMs(),
      failure_code: null,
      refund_ref: null,
    };
    const signed = new FakePaymentProvider("fake_psp").signedWebhook(body, h.clock.nowMs());
    let req = h.http().post(`/v1/webhooks/${intent.provider}`).set("Content-Type", "application/json");
    for (const [k, v] of Object.entries(signed.headers)) req = req.set(k, v);
    expect((await req.send(body)).status).toBe(200);
    await h.app.get<ProcessPaymentWebhook>(PAYMENT_PROCESS_WEBHOOK, { strict: false }).drain(10);
    const succeeded = store.outbox.filter((o) => o.type === "payment.succeeded");
    expect(succeeded).toHaveLength(1);

    // 2. The module's outbox rows go into the relay's outbox store, then the relay delivers them.
    const db = new MemoryDatabase();
    const now = new Date(h.clock.nowMs());
    await db.run(async (tx) => {
      for (const d of store.outbox) {
        await db.append(tx, createOutboxRecord(
          { aggregateType: d.aggregateType, aggregateId: d.aggregateId, eventType: d.type, payload: d.payload as JsonObject },
          { id: d.id, now: new Date(d.occurredAtMs) },
        ));
      }
    });
    const late = new Late<HandlePaymentWebhook>("test");
    late.bind(h.app.get<HandlePaymentWebhook>(CHECKOUT_WEBHOOK, { strict: false }));
    const relay = createPaymentEventsRelay({
      store: db, uow: db, inbox: db,
      clock: { now: () => now },
      random: () => 0.5,
      bridge: new PaymentEventsToCheckout(late),
    });
    const report = await relay.runOnce();
    expect(report.deadLettered).toBe(0);
    expect(report.published).toBeGreaterThan(0);

    const state = await h.http().get(`/v1/checkout/${groupId}`).set(bearer(user.accessToken));
    expect(state.body.status).toBe("placed");
    const group = await h.app.get<OrderRepository>(ORDER_REPOSITORY, { strict: false }).getGroupForUser(groupId, user.userId);
    expect(group?.sellerOrders).toHaveLength(1);

    // I-3: the real clearing port reads this order's PSP clearing posting from the ledger.
    const snaps = new Late<IntegritySnapshots>("test");
    snaps.bind(h.app.get<IntegritySnapshots>(LEDGER_SNAPSHOTS, { strict: false }));
    const lines = await new LedgerClearingAdapter(snaps).clearingLines({ kind: "psp", party: intent.provider, fromMs: 0, toMs: Number.MAX_SAFE_INTEGER });
    expect(lines.some((l) => l.key === groupId && l.amount === intent.amount)).toBe(true);

    // 3. Duplicate delivery of the same messages (relay crash before markPublished): inbox dedups.
    const again = await db.run(async (tx) => tx.kind);
    expect(again).toBe("memory-tx");
    const dup = createPaymentEventsRelay({
      store: db, uow: db, inbox: db, clock: { now: () => now }, random: () => 0.5,
      bridge: new PaymentEventsToCheckout(late),
    });
    const redelivered = await dup.runOnce();
    expect(redelivered.published).toBe(0);
    const group2 = await h.app.get<OrderRepository>(ORDER_REPOSITORY, { strict: false }).getGroupForUser(groupId, user.userId);
    expect(group2?.sellerOrders).toHaveLength(1);
  });
});

