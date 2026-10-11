import { describe, expect, it } from "vitest";
import { PlaceCheckout, type CommitInput } from "../application/commit";
import { HandlePaymentWebhook } from "../application/payment-events";
import { CREDIT_HOLD_GRACE_SECONDS } from "../application/saga-runner";
import { money, type CheckoutMethod } from "../domain/bridge";
import { ADDRESS, SHOPPER, createWorld, type World } from "./world";

const input = (over: Partial<CommitInput> = {}): CommitInput => ({
  userId: SHOPPER,
  deviceId: "dev-1",
  idempotencyKey: "key-1",
  method: "card",
  addressId: ADDRESS,
  codes: [],
  useStoreCredit: true,
  priceLock: null,
  expectedTotal: null,
  appAttestAssertion: null,
  ...over,
});

const withCredit = (): World => {
  const w = createWorld();
  w.credit.setBalances(SHOPPER, [{ sub: { kind: "goodwill" } as never, balance: money(50_000n), expiresAt: null }]);
  return w;
};

const pay = async (w: World, groupId: string) => {
  w.provider.markSucceeded(`pi_${groupId}`);
  const rec = await w.repo.get(groupId);
  const e = w.provider.webhook({
    eventId: `evt-${groupId}`,
    intentId: `pi_${groupId}`,
    orderGroupId: groupId,
    kind: "succeeded",
    amount: rec?.facts.externalDue ?? 0n,
  });
  return new HandlePaymentWebhook(w.ctx).execute({ provider: "fake-psp", rawBody: e.rawBody, headers: e.headers });
};

describe("F-1 credit hold lifetime follows the method's payment window", () => {
  const windows: ReadonlyArray<readonly [CheckoutMethod, number]> = [
    ["card", 10 * 60],
    ["mobile_wallet", 30 * 60],
    ["fawry", 24 * 3600],
  ];
  for (const [method, seconds] of windows) {
    it(`${method}: hold asks for the window (${seconds}s) plus the grace`, async () => {
      const w = withCredit();
      const r = await new PlaceCheckout(w.ctx).execute(input({ method }));
      if (r.kind !== "ok") throw new Error(`expected ok, got ${r.kind}`);
      const id = r.record.facts.holdId;
      if (id === null) throw new Error("no hold");
      expect(w.credit.ttlSecondsOf(id)).toBe(seconds + CREDIT_HOLD_GRACE_SECONDS);
    });
  }
});

describe("F-1 capture is a hard step, atomic with the ledger entry", () => {
  it("a hold lost before payment is re-held, captured, and the order entry debits exactly the consumed credit", async () => {
    const w = withCredit();
    const r = await new PlaceCheckout(w.ctx).execute(input({ method: "mobile_wallet" }));
    if (r.kind !== "ok") throw new Error("x");
    const g = r.record.orderGroupId;
    const first = r.record.facts.holdId;
    if (first === null) throw new Error("no hold");
    w.credit.forceRelease(first); // what the old 10 minute sweeper did (debit-normal: the order entry debited the credit account)
    expect((await pay(w, g)).kind).toBe("applied");
    const rec = await w.repo.get(g);
    expect(rec?.facts.status).toBe("PLACED");
    expect(rec?.facts.holdCaptured).toBe(true);
    expect(rec?.facts.holdId).not.toBe(first);
    expect(w.credit.captured()).toBe(1);
    expect(w.credit.leaked()).toBe(0);
    expect(w.ledger.trialBalance()).toBe(0n);
    expect(w.ledger.balance(`store_credit:${SHOPPER}:goodwill`)).toBe(50_000n);
  });

  it("a hold lost and not re-holdable compensates the whole group: refunded, nothing recognised, no orders", async () => {
    const w = withCredit();
    const r = await new PlaceCheckout(w.ctx).execute(input({ method: "mobile_wallet" }));
    if (r.kind !== "ok") throw new Error("x");
    const g = r.record.orderGroupId;
    const first = r.record.facts.holdId;
    if (first === null) throw new Error("no hold");
    w.credit.forceRelease(first);
    w.credit.denyNewHolds = true;
    await pay(w, g);
    const rec = await w.repo.get(g);
    expect(rec?.facts.status).toBe("REFUNDED");
    expect(rec?.facts.holdCaptured).toBe(false);
    expect(rec?.facts.refunded).toBe(true);
    expect(w.orders.placed.size).toBe(0);
    expect(w.provider.netCharged()).toBe(0n);
    expect(w.ledger.balance(`store_credit:${SHOPPER}:goodwill`)).toBe(0n);
    expect(w.inventory.activeReservations()).toBe(0);
    // R-2: a claimed-then-compensated group must not keep its units: none claimed, all stock available.
    expect(w.inventory.claimedGroups()).toBe(0);
    expect(w.inventory.oversold()).toBe(false);
    expect(w.ledger.trialBalance()).toBe(0n);
  });
});
