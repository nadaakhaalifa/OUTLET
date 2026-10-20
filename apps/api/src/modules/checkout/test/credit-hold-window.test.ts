/**
 * F-1 invariant: the store-credit hold must follow the payment window of the method, and after
 * PLACED the credit consumed (lots) equals the store_credit debit of the order entry (ledger).
 * The clock is moved past the old 10 minute hold TTL, and the sweeper runs, before the payment event.
 */
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CART_CATALOG, type FakeCatalog } from "../../cart";
import { CHECKOUT_CONTEXT, CHECKOUT_WEBHOOK, type CheckoutContext, type FakeAddresses, type HandlePaymentWebhook } from "..";
import { INVENTORY_SKU_DIRECTORY, INVENTORY_SYNC_STOCK, type InMemorySkuDirectory, type SyncSellerStock } from "../../inventory";
import { LEDGER_READ_MODEL, type LedgerReadModel } from "../../ledger";
import { PAYMENT_STORE, type PaymentStore } from "../../payments";
import { CREDIT_HOLDS, GRANT_CREDIT, STORE_CREDIT_STORE, type CreditHolds, type GrantCredit, type StoreCreditStore } from "../../store-credit";
import { createHarness, login, type Harness } from "../../../test/harness";
import { Late } from "../../../composition/late";
import { COMMERCE_TERMS_REGISTRY, type RegisteredCommerceTerms } from "../../../composition/money-wiring";
import { PaymentEventsToCheckout } from "../../../composition/money-adapters";
import { money } from "../../../composition/domain";

const uid = (n: number): string => `0192f3a4-5b6c-7d8e-9fa1-${String(n).padStart(12, "0")}`;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const CREDIT = 40_000n;

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());

let seq = 1;

async function run(method: "card" | "mobile_wallet", advanceMs: number, sweepOnly = false): Promise<void> {
  const n = seq++ * 100;
  const [STORE, SKU, PRODUCT, LOCATION, ADDRESS] = [uid(n + 1), uid(n + 2), uid(n + 3), uid(n + 4), uid(n + 5)];
  const phone = `+2010099${String(70000 + n).slice(-5)}`;
  const user = await login(h, phone);
  h.app.get<RegisteredCommerceTerms>(COMMERCE_TERMS_REGISTRY, { strict: false }).register(STORE, 1_500);
  const catalog = h.app.get<FakeCatalog>(CART_CATALOG, { strict: false });
  catalog.addStore(STORE);
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
    quantity: 100,
    reason: "received",
    idempotencyKey: `hold-window-stock-${n}`,
  });
  (h.app.get<CheckoutContext>(CHECKOUT_CONTEXT, { strict: false }).addresses as FakeAddresses).add(user.userId, ADDRESS);
  await h.app.get<GrantCredit>(GRANT_CREDIT, { strict: false }).promo({
    userId: user.userId,
    sub: { kind: "goodwill" },
    amount: money(CREDIT),
    key: `hold-window-goodwill-${n}`,
  });
  const add = await h.http().post("/v1/cart/lines").set(bearer(user.accessToken)).set("Idempotency-Key", uid(n + 11)).send({ sku_id: SKU, qty: 1 });
  expect(add.status).toBe(201);
  const placed = await h
    .http()
    .post("/v1/checkout")
    .set(bearer(user.accessToken))
    .set("Idempotency-Key", uid(n + 12))
    .send({ method, address_id: ADDRESS, use_store_credit: true });
  expect(placed.status, JSON.stringify(placed.body)).toBeLessThan(300);
  const groupId = String(placed.body.order_group_id);

  h.clock.advance(advanceMs);
  await h.app.get<CreditHolds>(CREDIT_HOLDS, { strict: false }).sweepExpired();
  if (sweepOnly) {
    // R-6: the saga is still awaiting payment (non-terminal): the sweeper must not release its hold.
    const st = h.app.get<StoreCreditStore>(STORE_CREDIT_STORE, { strict: false });
    expect((await st.getHold(user.userId, `hold:${groupId}`))?.status).toBe("held");
    return;
  }

  const intent = await h.app.get<PaymentStore>(PAYMENT_STORE, { strict: false }).getIntentByOrderGroup(groupId);
  if (intent === null) throw new Error("intent missing");
  const late = new Late<HandlePaymentWebhook>("hold-window");
  late.bind(h.app.get<HandlePaymentWebhook>(CHECKOUT_WEBHOOK, { strict: false }));
  await new PaymentEventsToCheckout(late).handle({
    id: uid(n + 90),
    type: "payment.succeeded",
    occurredAtMs: h.clock.nowMs(),
    payload: { intent_id: intent.id, order_group_id: groupId, amount: intent.amount.toString(), currency: "EGP", provider: intent.provider },
  });
  const fresh = await login(h, phone);
  const state = await h.http().get(`/v1/checkout/${groupId}`).set(bearer(fresh.accessToken));
  expect(state.body.status).toBe("placed");

  // Lots: the whole credit was consumed. Ledger: the store_credit account was debited by exactly that.
  const store = h.app.get<StoreCreditStore>(STORE_CREDIT_STORE, { strict: false });
  const remaining = (await store.listLots(user.userId)).reduce((a, l) => a + l.remaining, 0n);
  const txns = await store.listTransactions(user.userId, { after: null, limit: 50 });
  const used = txns.filter((t) => t.kind === "credit_used").reduce((a, t) => a + t.amount, 0n);
  expect(remaining).toBe(0n);
  expect(used).toBe(CREDIT);
  const reads = h.app.get<LedgerReadModel>(LEDGER_READ_MODEL, { strict: false });
  const rows = await reads.balances({ actorId: user.userId, role: "finance" }, { type: "store_credit", ownerId: user.userId, limit: 10 });
  const ledgerBalance = rows.reduce((a, r) => a + r.natural, 0n);
  // granted (Cr) minus the order entry's store_credit debits (Dr) equals what is left in the lots.
  expect(ledgerBalance).toBe(CREDIT - used);
}

describe("F-1 store credit hold follows the payment window and capture is atomic with the ledger entry", () => {
  it("card: paid in the last second of the 10 minute window", async () => run("card", 599_000));
  it("mobile wallet: paid after the old 10 minute TTL, inside the 30 minute window", async () => run("mobile_wallet", 25 * 60_000));
  it("mobile wallet: paid in the last minute of the 30 minute window", async () => run("mobile_wallet", 29 * 60_000));
  it("R-6: a sweep long after the hold TTL never releases the hold of a non-terminal saga (real wiring)", async () => run("card", 3 * 3_600_000, true));
});
