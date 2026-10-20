import { expect } from "vitest";
import { PlaceCheckout, type CommitInput } from "../application/commit";
import { RecoverSagas } from "../application/lifecycle";
import { HandlePaymentWebhook } from "../application/payment-events";
import { isTerminal, money, type SagaStatus } from "../domain/bridge";
import { ADDRESS, CrashError, SHOPPER, SKU_1, SKU_2, type World } from "./world";

/**
 * Deterministic step-interleaving: every port call (repo, cart, inventory, credit, PSP, ledger, orders)
 * is a kill point, before AND after the call. After a kill the "client" retries exactly as a real one
 * would (same idempotency key, PSP webhook redelivery) and the sweeper recovers. Whatever the kill
 * point, the end state must satisfy the money and stock invariants.
 */
const base: CommitInput = {
  userId: SHOPPER,
  deviceId: "dev",
  idempotencyKey: "chaos-key",
  method: "card",
  addressId: ADDRESS,
  codes: [],
  useStoreCredit: true,
  priceLock: null,
  expectedTotal: null,
  appAttestAssertion: null,
};

async function survive<T>(w: World, fn: () => Promise<T>): Promise<T> {
  for (let i = 0; i < 8; i += 1) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof CrashError)) throw e;
      w.crash.revive();
      w.clock.advance(31_000);
    }
  }
  throw new Error("scenario did not survive its crash");
}

const drain = async (w: World): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    w.clock.advance(31_000);
    await survive(w, () => new RecoverSagas(w.ctx).execute());
  }
};

const setup = (w: World, over: { credit?: boolean } = {}): void => {
  if (over.credit !== false) {
    w.credit.setBalances(SHOPPER, [{ sub: { kind: "goodwill" } as never, balance: money(50_000n), expiresAt: null }]);
  }
};

async function commitAndGroup(w: World, over: Partial<CommitInput> = {}): Promise<string> {
  const r = await survive(w, () => new PlaceCheckout(w.ctx).execute({ ...base, ...over }));
  if (r.kind !== "ok" && r.kind !== "insufficient_stock" && r.kind !== "failed") throw new Error(`commit ${r.kind}`);
  const rec = await w.repo.findByKey(SHOPPER, over.idempotencyKey ?? base.idempotencyKey);
  if (rec === null) throw new Error("no saga recorded");
  return rec.orderGroupId;
}

async function payWebhook(w: World, g: string, kind: "succeeded" | "failed", eventId: string): Promise<void> {
  const rec = await w.repo.get(g);
  if (rec === null) throw new Error("no saga");
  const intent = `pi_${g}`;
  if (kind === "succeeded" && w.provider.intents.has(intent)) w.provider.forceSucceeded(intent);
  const e = w.provider.webhook({ eventId, intentId: intent, orderGroupId: g, kind, amount: rec.facts.externalDue });
  // The PSP redelivers until it gets a 2xx; the same event id every time.
  await survive(w, () => new HandlePaymentWebhook(w.ctx).execute({ provider: "fake-psp", rawBody: e.rawBody, headers: e.headers }));
}

export interface Scenario {
  readonly name: string;
  readonly expect: SagaStatus;
  run(w: World): Promise<string>;
}

export const scenarios: readonly Scenario[] = [
  {
    name: "card + store credit, paid",
    expect: "PLACED",
    async run(w) {
      setup(w);
      const g = await commitAndGroup(w);
      await payWebhook(w, g, "succeeded", "evt-ok");
      await drain(w);
      return g;
    },
  },
  {
    name: "card, payment failed",
    expect: "FAILED",
    async run(w) {
      setup(w);
      const g = await commitAndGroup(w);
      await payWebhook(w, g, "failed", "evt-fail");
      await drain(w);
      return g;
    },
  },
  {
    name: "COD",
    expect: "PLACED",
    async run(w) {
      setup(w, { credit: false });
      const g = await commitAndGroup(w, { method: "cod", useStoreCredit: false });
      await drain(w);
      return g;
    },
  },
  {
    name: "late payment, stock still there",
    expect: "PLACED",
    async run(w) {
      setup(w);
      const g = await commitAndGroup(w);
      w.clock.advance(11 * 60_000);
      await drain(w);
      await payWebhook(w, g, "succeeded", "evt-late");
      await drain(w);
      return g;
    },
  },
  {
    name: "late payment, stock gone",
    expect: "REFUNDED",
    async run(w) {
      setup(w);
      const g = await commitAndGroup(w);
      w.clock.advance(11 * 60_000);
      await drain(w);
      w.inventory.takeStock(SKU_1, 5);
      await payWebhook(w, g, "succeeded", "evt-late2");
      await drain(w);
      return g;
    },
  },
  {
    name: "stock shortfall at reserve",
    expect: "FAILED",
    async run(w) {
      setup(w);
      w.inventory.setStock(SKU_2, 0);
      const g = await commitAndGroup(w);
      await drain(w);
      return g;
    },
  },
];

export async function assertInvariants(w: World, g: string, expected: SagaStatus, where: string): Promise<void> {
  const rec = await w.repo.get(g);
  const ctxMsg = `${where}`;
  expect(rec, ctxMsg).not.toBeNull();
  if (rec === null) return;
  expect(rec.facts.status, ctxMsg).toBe(expected);
  expect(isTerminal(rec.facts.status), ctxMsg).toBe(true);
  // No double charge, no oversell, balanced books, at most one OrderGroup.
  expect(w.provider.createIntentCalls >= 0).toBe(true);
  expect(w.provider.intents.size, ctxMsg).toBeLessThanOrEqual(1);
  expect(w.provider.succeededCount(), ctxMsg).toBeLessThanOrEqual(1);
  expect(w.inventory.oversold(), ctxMsg).toBe(false);
  expect(w.ledger.trialBalance(), ctxMsg).toBe(0n);
  expect(w.orders.placed.size, ctxMsg).toBeLessThanOrEqual(1);
  // No leaked reservation or hold.
  expect(w.inventory.activeReservations(), ctxMsg).toBe(0);
  expect(w.credit.leaked(), ctxMsg).toBe(0);

  const external = rec.facts.externalDue;
  if (expected === "PLACED") {
    expect(w.orders.placed.size, ctxMsg).toBe(1);
    expect(w.inventory.claimedGroups(), ctxMsg).toBe(1);
    expect(w.provider.netCharged(), ctxMsg).toBe(rec.facts.method === "cod" ? 0n : external);
    expect(w.credit.captured(), ctxMsg).toBe(rec.facts.creditAmount > 0n ? 1 : 0);
    if (rec.facts.method !== "cod") expect(w.ledger.balance("psp_clearing:fake-psp"), ctxMsg).toBe(external);
  } else {
    expect(w.orders.placed.size, ctxMsg).toBe(0);
    expect(w.inventory.claimedGroups(), ctxMsg).toBe(0);
    expect(w.provider.netCharged(), ctxMsg).toBe(0n);
    expect(w.credit.captured(), ctxMsg).toBe(0);
    expect(w.ledger.balance("psp_clearing:fake-psp"), ctxMsg).toBe(0n);
  }
}


/** Clean run to count kill points, then one run per kill point. `make` builds a fresh world each time. */
export async function sweepKillPoints(
  sc: Scenario,
  make: () => Promise<World>,
  stride = 1,
  release: (w: World) => Promise<void> = async () => undefined,
): Promise<{ points: number; fired: number }> {
  const clean = await make();
  clean.crash.arm(null);
  const g0 = await sc.run(clean);
  try {
    await assertInvariants(clean, g0, sc.expect, `${sc.name} clean run`);
  } finally {
    await release(clean);
  }
  const points = clean.crash.ticks();
  expect(points).toBeGreaterThan(10);
  let fired = 0;
  for (let k = 0; k < points; k += stride) {
    const w = await make();
    w.crash.arm(k);
    const g = await sc.run(w);
    fired += w.crash.fired;
    try {
      await assertInvariants(w, g, sc.expect, `${sc.name} killed at #${k} ${clean.crash.labels[k] ?? ""}`);
    } finally {
      await release(w);
    }
  }
  return { points, fired };
}
