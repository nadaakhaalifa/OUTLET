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
import { INTEGRITY_JOB, type IntegrityJob } from "../modules/ledger";
import { PAYMENT_STORE, type PaymentStore } from "../modules/payments";
import { ORDER_REPOSITORY, type OrderRepository } from "../modules/orders";
import { REFUND_FACTS } from "../modules/refunds";
import { INTAKE_REFUND_INTENT, PROCESS_REFUND, RefundRecognitionMissingError, type FakeRefundFacts, type IntakeRefundIntent, type ProcessRefund } from "../modules/refunds";
import { createHarness, login, type Harness } from "../test/harness";
import { Late } from "./late";
import { PaymentEventsToCheckout } from "./money-adapters";
import { COMMERCE_TERMS_REGISTRY, type RegisteredCommerceTerms } from "./money-wiring";

const uid = (n: number): string => `0192f3a4-5b6c-7d8e-9f02-${String(n).padStart(12, "0")}`;
const STORE = uid(1);
const LOCATION = uid(4);
const ADDRESS = uid(5);
const KEY = (n: number): string => `0192f3a4-5b6c-7d8e-9f03-${String(n).padStart(12, "0")}`;

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

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


async function placeCardOrder(phone: string, n: number): Promise<{ token: string; userId: string; groupId: string; intentAmount: bigint; provider: string }> {
  const user = await login(h, phone);
  const STORE_X = uid(60 + n);
  await seedCart(user, 20 + n, STORE_X, true);
  const placed = await h.http().post("/v1/checkout").set(bearer(user.accessToken)).set("Idempotency-Key", KEY(300 + n)).send({ method: "card", address_id: ADDRESS, use_store_credit: false });
  expect(placed.status, JSON.stringify(placed.body)).toBeLessThan(300);
  const groupId = String(placed.body.order_group_id);
  const intent = await h.app.get<PaymentStore>(PAYMENT_STORE, { strict: false }).getIntentByOrderGroup(groupId);
  if (intent === null) throw new Error("no intent");
  const late = new Late<HandlePaymentWebhook>("test");
  late.bind(h.app.get<HandlePaymentWebhook>(CHECKOUT_WEBHOOK, { strict: false }));
  const out = await new PaymentEventsToCheckout(late).handle({
    id: uid(950 + n),
    type: "payment.succeeded",
    occurredAtMs: h.clock.nowMs(),
    payload: { intent_id: intent.id, order_group_id: groupId, amount: intent.amount.toString(), currency: "EGP", provider: intent.provider },
  });
  expect(out).toBe("applied");
  return { token: user.accessToken, userId: user.userId, groupId, intentAmount: intent.amount, provider: intent.provider };
}

describe("R-1: a REAL checkout to PLACED is refundable through the real posting service", () => {
  it("posts under the shared recognition key, refunds once, balances, replays idempotently", async () => {
    const o = await placeCardOrder("+201009990071", 1);
    const state = await h.http().get(`/v1/checkout/${o.groupId}`).set(bearer(o.token));
    expect(state.body.status).toBe("placed");
    const group = await h.app.get<OrderRepository>(ORDER_REPOSITORY, { strict: false }).getGroupForUser(o.groupId, o.userId);
    const so = group?.sellerOrders[0];
    const line = so?.lines[0];
    if (so === undefined || line === undefined) throw new Error("no seller order");
    const facts = h.app.get<FakeRefundFacts>(REFUND_FACTS, { strict: false });
    const goods = line.unitPrice.amount * BigInt(line.qty) - line.discountAlloc.amount;
    facts.seed(so.id, {
      userId: o.userId,
      storeId: so.storeId,
      orderGroupId: o.groupId,
      deliveryFee: so.shipping.amount,
      deliveryFeeRefundedBefore: 0n,
      commissionBps: 1_500n,
      vatBps: 1_400n,
      tenders: [{ id: "t1", method: "card", amount: { amount: o.intentAmount, currency: "EGP" }, refundedBefore: { amount: 0n, currency: "EGP" }, psp: o.provider }],
      lines: [{ orderLineId: line.id, gross: goods, refundedBefore: 0n }],
      platformVoucher: 0n,
      sellerVoucher: 0n,
      returnReceivedAtMs: h.clock.nowMs(),
      choice: { cod: "store_credit" },
    });
    const returnId = uid(8100);
    const msg = {
      messageId: uid(8101),
      event: {
        name: "return.refund_intent",
        returnId,
        userId: o.userId,
        storeId: so.storeId,
        sellerOrderId: so.id,
        orderLineId: line.id,
        reason: "too_small",
        refundPreference: "original_method",
        shippingPayer: "seller",
        currency: "EGP",
        allocation: {
          lines: [{ orderLineId: line.id, qty: line.qty, itemAmount: goods.toString(), voucherShare: "0", deliveryFeeShare: "0", netAmount: goods.toString() }],
          itemTotal: goods.toString(),
          voucherTotal: "0",
          deliveryFeeTotal: "0",
          netTotal: goods.toString(),
        },
        idempotencyKey: `refund-intent:${returnId}`,
        occurredAtMs: h.clock.nowMs(),
      },
    };
    const created = await h.app.get<IntakeRefundIntent>(INTAKE_REFUND_INTENT, { strict: false }).execute(msg);
    expect(created.kind).toBe("created");
    const refundId = created.kind === "created" ? created.refundId : "";
    const process = h.app.get<ProcessRefund>(PROCESS_REFUND, { strict: false });
    const r = await process.execute(refundId);
    expect(r?.ledger).toBe("posted");
    const again = await process.execute(refundId);
    expect(again?.ledger).not.toBe("failed");
    const report = await h.app.get<IntegrityJob>(INTEGRITY_JOB, { strict: false }).run();
    expect(report.trialBalance.ok).toBe(true);
    expect(report.chain.ok).toBe(true);
  });

  it("refunds fail closed while no recognition entry (prepaid order_paid or COD order_cod_confirmed) exists", async () => {
    const user = await login(h, "+201009990072");
    const groupId = uid(8200);
    const sellerOrderId = uid(8201);
    const lineId = uid(8202);
    h.app.get<FakeRefundFacts>(REFUND_FACTS, { strict: false }).seed(sellerOrderId, {
      userId: user.userId,
      storeId: STORE,
      orderGroupId: groupId,
      deliveryFee: 0n,
      deliveryFeeRefundedBefore: 0n,
      commissionBps: 1_500n,
      vatBps: 1_400n,
      tenders: [{ id: "c1", method: "cod", amount: { amount: 10_000n, currency: "EGP" }, refundedBefore: { amount: 0n, currency: "EGP" }, courier: "bosta" }],
      lines: [{ orderLineId: lineId, gross: 10_000n, refundedBefore: 0n }],
      platformVoucher: 0n,
      sellerVoucher: 0n,
      returnReceivedAtMs: h.clock.nowMs(),
      choice: { cod: "store_credit" },
    });
    const returnId = uid(8203);
    const created = await h.app.get<IntakeRefundIntent>(INTAKE_REFUND_INTENT, { strict: false }).execute({
      messageId: uid(8204),
      event: {
        name: "return.refund_intent",
        returnId,
        userId: user.userId,
        storeId: STORE,
        sellerOrderId,
        orderLineId: lineId,
        reason: "too_small",
        refundPreference: "store_credit",
        shippingPayer: "seller",
        currency: "EGP",
        allocation: {
          lines: [{ orderLineId: lineId, qty: 1, itemAmount: "10000", voucherShare: "0", deliveryFeeShare: "0", netAmount: "10000" }],
          itemTotal: "10000",
          voucherTotal: "0",
          deliveryFeeTotal: "0",
          netTotal: "10000",
        },
        idempotencyKey: `refund-intent:${returnId}`,
        occurredAtMs: h.clock.nowMs(),
      },
    });
    expect(created.kind).toBe("created");
    const refundId = created.kind === "created" ? created.refundId : "";
    await expect(h.app.get<ProcessRefund>(PROCESS_REFUND, { strict: false }).execute(refundId)).rejects.toBeInstanceOf(RefundRecognitionMissingError);
  });
});
