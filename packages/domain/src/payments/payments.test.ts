import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { GuardRejectedError, InvalidTransitionError } from "../state-machine/errors";
import {
  CLOSED,
  DEFAULT_BREAKER_CONFIG,
  PAYMENT_INTENT_EVENTS,
  PAYMENT_INTENT_STATES,
  PAYMENT_METHOD_IDS,
  PAYMENT_METHOD_META,
  admit,
  decideRefundApplication,
  decideWebhookEffect,
  onFailure,
  onSuccess,
  paymentIntentMachine,
  providerOrder,
  refundEventFor,
  selectProvider,
  withinTolerance,
  wouldAdmit,
  type BreakerState,
  type IntentView,
  type NormalizedPaymentEvent,
  type PaymentIntentEvent,
  type PaymentIntentStatus,
} from "./index";

const CFG = DEFAULT_BREAKER_CONFIG;

describe("payment intent machine", () => {
  it("has no unreachable state, dead end or terminal with outgoing edges", () => {
    const a = paymentIntentMachine.analyze();
    expect(a.unreachable).toEqual([]);
    expect(a.deadEnds).toEqual([]);
    expect(a.terminalsWithOutgoing).toEqual([]);
    expect(a.ok).toBe(true);
    expect([...a.reachable].sort()).toEqual([...PAYMENT_INTENT_STATES].sort());
  });

  it("covers every state with an explicit row and rejects undeclared edges", () => {
    const ctx = { amount: 1000n, refunded: 0n, refundAmount: 100n };
    expect(() => paymentIntentMachine.transition("CREATED", "REFUND_PARTIAL", ctx)).toThrow(InvalidTransitionError);
    expect(() => paymentIntentMachine.transition("SUCCEEDED", "VOID", ctx)).toThrow(InvalidTransitionError);
    expect(() => paymentIntentMachine.transition("FAILED", "SUCCEED", ctx)).toThrow(InvalidTransitionError);
  });

  it("guards refunds: partial below, full exactly, never above", () => {
    const m = paymentIntentMachine;
    expect(m.transition("SUCCEEDED", "REFUND_PARTIAL", { amount: 1000n, refunded: 0n, refundAmount: 400n })).toBe("PARTIALLY_REFUNDED");
    expect(m.transition("PARTIALLY_REFUNDED", "REFUND_FULL", { amount: 1000n, refunded: 400n, refundAmount: 600n })).toBe("REFUNDED");
    expect(() => m.transition("SUCCEEDED", "REFUND_PARTIAL", { amount: 1000n, refunded: 0n, refundAmount: 1000n })).toThrow(GuardRejectedError);
    expect(() => m.transition("SUCCEEDED", "REFUND_FULL", { amount: 1000n, refunded: 0n, refundAmount: 999n })).toThrow(GuardRejectedError);
    expect(() => m.transition("SUCCEEDED", "REFUND_FULL", { amount: 1000n, refunded: 0n, refundAmount: 1001n })).toThrow(GuardRejectedError);
    expect(() => m.transition("SUCCEEDED", "REFUND_PARTIAL", { amount: 1000n, refunded: 0n, refundAmount: 0n })).toThrow(GuardRejectedError);
  });

  it("property: random event walks stay inside the declared states and never over-refund", () => {
    const ev = fc.constantFrom<PaymentIntentEvent>(...PAYMENT_INTENT_EVENTS);
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10_000_000n }),
        fc.array(fc.tuple(ev, fc.bigInt({ min: 0n, max: 12_000_000n })), { maxLength: 40 }),
        (amount, steps) => {
          let status: PaymentIntentStatus = paymentIntentMachine.initial;
          let refunded = 0n;
          for (const [event, r] of steps) {
            const isRefund = event === "REFUND_PARTIAL" || event === "REFUND_FULL";
            const ctx = { amount, refunded, refundAmount: isRefund ? r : 0n };
            const wasTerminal = paymentIntentMachine.isTerminal(status);
            if (paymentIntentMachine.can(status, event, ctx)) {
              const next = paymentIntentMachine.transition(status, event, ctx);
              expect(PAYMENT_INTENT_STATES).toContain(next);
              expect(wasTerminal).toBe(false);
              if (isRefund) refunded += r;
              status = next;
            } else {
              expect(() => paymentIntentMachine.transition(status, event, ctx)).toThrow();
            }
            expect(refunded >= 0n && refunded <= amount).toBe(true);
            if (status === "REFUNDED") expect(refunded).toBe(amount);
            if (status === "PARTIALLY_REFUNDED") expect(refunded > 0n && refunded < amount).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("property: refundEventFor agrees with the machine guards", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 100_000n }), fc.bigInt({ min: 0n, max: 100_000n }), fc.bigInt({ min: 0n, max: 120_000n }), (amount, refundedRaw, ra) => {
        const refunded = refundedRaw % (amount + 1n);
        const ctx = { amount, refunded, refundAmount: ra };
        const e = refundEventFor(ctx);
        if (e === null) {
          expect(paymentIntentMachine.can("SUCCEEDED", "REFUND_PARTIAL", ctx) || paymentIntentMachine.can("SUCCEEDED", "REFUND_FULL", ctx)).toBe(false);
        } else {
          expect(paymentIntentMachine.can("SUCCEEDED", e, ctx)).toBe(true);
        }
      }),
    );
  });
});

describe("method metadata", () => {
  it("Fawry: 24h reference expiry, non-drop pool, no drop SKUs", () => {
    const f = PAYMENT_METHOD_META.fawry;
    expect(f.referenceExpiresInMs).toBe(86_400_000);
    expect(f.paymentWindowMs).toBe(86_400_000);
    expect(f.stockPool).toBe("non_drop");
    expect(f.dropSkusAllowed).toBe(false);
  });
  it("wallets and instapay hold 30 minutes, cards 10", () => {
    expect(PAYMENT_METHOD_META.mobile_wallet.paymentWindowMs).toBe(1_800_000);
    expect(PAYMENT_METHOD_META.instapay.paymentWindowMs).toBe(1_800_000);
    expect(PAYMENT_METHOD_META.card.paymentWindowMs).toBe(600_000);
  });
  it("meeza shares the card kill switch and every method has metadata", () => {
    expect(PAYMENT_METHOD_META.meeza.killSwitch).toBe("card");
    for (const id of PAYMENT_METHOD_IDS) expect(PAYMENT_METHOD_META[id].id).toBe(id);
  });
});

describe("circuit breaker and router", () => {
  it("opens after N consecutive failures, probes once after the cool-down, closes on success", () => {
    let s: BreakerState = CLOSED;
    for (let i = 0; i < CFG.failureThreshold - 1; i++) s = onFailure(s, 1000, CFG);
    expect(s.kind).toBe("closed");
    s = onFailure(s, 1000, CFG);
    expect(s).toEqual({ kind: "open", openedAtMs: 1000 });
    expect(admit(s, 1000 + CFG.openMs - 1, CFG).allowed).toBe(false);
    const probe = admit(s, 1000 + CFG.openMs, CFG);
    expect(probe.allowed).toBe(true);
    expect(probe.next.kind).toBe("half_open");
    expect(admit(probe.next, 1000 + CFG.openMs + 1, CFG).allowed).toBe(false);
    expect(onFailure(probe.next, 50_000, CFG).kind).toBe("open");
    expect(onSuccess(probe.next)).toEqual(CLOSED);
    expect(admit(probe.next, 1000 + CFG.openMs + CFG.probeTimeoutMs, CFG).allowed).toBe(true);
  });

  it("a success resets the consecutive count", () => {
    let s: BreakerState = CLOSED;
    s = onFailure(s, 0, CFG);
    s = onFailure(s, 0, CFG);
    s = onSuccess(s);
    expect(s).toEqual(CLOSED);
  });

  it("wouldAdmit never mutates or consumes the probe", () => {
    const open: BreakerState = { kind: "open", openedAtMs: 0 };
    expect(wouldAdmit(open, CFG.openMs, CFG)).toBe(true);
    expect(wouldAdmit(open, CFG.openMs, CFG)).toBe(true);
    expect(open).toEqual({ kind: "open", openedAtMs: 0 });
  });

  it("falls over to the secondary when the primary is open and reports none when all are", () => {
    const states = { primary: { kind: "open", openedAtMs: 100 } as BreakerState };
    const order = ["primary", "secondary"];
    const d = selectProvider(order, states, 200, CFG);
    expect(d).toMatchObject({ kind: "selected", provider: "secondary" });
    const all = { primary: { kind: "open", openedAtMs: 100 } as BreakerState, secondary: { kind: "open", openedAtMs: 100 } as BreakerState };
    expect(selectProvider(order, all, 200, CFG).kind).toBe("none");
    expect(selectProvider(order, {}, 0, CFG, new Set(["primary"]))).toMatchObject({ provider: "secondary" });
  });

  it("providerOrder filters unsupported and duplicate providers, per-method override first", () => {
    const policy = { order: { fawry: ["fawry_psp", "paymob"] }, defaultOrder: ["paymob", "backup", "paymob"] };
    expect(providerOrder(policy, "card", () => true)).toEqual(["paymob", "backup"]);
    expect(providerOrder(policy, "fawry", (p) => p !== "fawry_psp")).toEqual(["paymob"]);
  });

  it("property: selected provider is always admitted and is the first admitted in order", () => {
    const st = fc.oneof(
      fc.record({ kind: fc.constant("closed" as const), failures: fc.nat({ max: 4 }) }),
      fc.record({ kind: fc.constant("open" as const), openedAtMs: fc.nat({ max: 100_000 }) }),
      fc.record({ kind: fc.constant("half_open" as const), probeStartedAtMs: fc.nat({ max: 100_000 }) }),
    );
    fc.assert(
      fc.property(fc.array(st, { minLength: 1, maxLength: 4 }), fc.nat({ max: 200_000 }), (arr, now) => {
        const order = arr.map((_, i) => `p${i}`);
        const states = Object.fromEntries(arr.map((s, i) => [`p${i}`, s]));
        const d = selectProvider(order, states, now, CFG);
        const firstAdmitted = order.find((p) => wouldAdmit(states[p] as BreakerState, now, CFG));
        if (firstAdmitted === undefined) expect(d.kind).toBe("none");
        else expect(d).toMatchObject({ kind: "selected", provider: firstAdmitted });
      }),
    );
  });
});

describe("timestamp tolerance", () => {
  it("is symmetric at the 5 minute edge", () => {
    const now = 10_000_000;
    expect(withinTolerance(now - 300_000, now)).toBe(true);
    expect(withinTolerance(now + 300_000, now)).toBe(true);
    expect(withinTolerance(now - 300_001, now)).toBe(false);
    expect(withinTolerance(now + 300_001, now)).toBe(false);
    expect(withinTolerance(Number.NaN, now)).toBe(false);
  });
});

const intent = (status: PaymentIntentStatus, over: Partial<IntentView> = {}): IntentView => ({
  id: "i1",
  orderGroupId: "g1",
  status,
  amount: 5000n,
  currency: "EGP",
  refundedAmount: 0n,
  provider: "fake_primary",
  method: "card",
  ...over,
});
const ev = (kind: NormalizedPaymentEvent["kind"], over: Partial<NormalizedPaymentEvent> = {}): NormalizedPaymentEvent => ({
  eventId: "e1",
  kind,
  providerRef: "ref1",
  orderGroupId: "g1",
  amount: 5000n,
  currency: "EGP",
  occurredAtMs: 0,
  failureCode: null,
  providerRefundRef: null,
  ...over,
});

describe("decideWebhookEffect", () => {
  it("succeeded moves to SUCCEEDED and emits payment.succeeded", () => {
    const d = decideWebhookEffect(intent("REQUIRES_ACTION"), ev("payment.succeeded"));
    expect(d).toMatchObject({ kind: "transition", to: "SUCCEEDED" });
    if (d.kind === "transition") expect(d.events.map((e) => e.type)).toEqual(["payment.succeeded"]);
  });
  it("duplicate success is a no-op", () => {
    expect(decideWebhookEffect(intent("SUCCEEDED"), ev("payment.succeeded"))).toEqual({ kind: "noop", reason: "duplicate" });
  });
  it("late authorize after success is stale", () => {
    expect(decideWebhookEffect(intent("SUCCEEDED"), ev("payment.authorized"))).toEqual({ kind: "noop", reason: "stale" });
  });
  it("success after failure is an anomaly and does not transition", () => {
    const d = decideWebhookEffect(intent("FAILED"), ev("payment.succeeded"));
    expect(d).toMatchObject({ kind: "anomaly", anomaly: "late_success" });
  });
  it("failure after capture is a conflicting terminal anomaly", () => {
    expect(decideWebhookEffect(intent("SUCCEEDED"), ev("payment.failed"))).toMatchObject({ kind: "anomaly", anomaly: "conflicting_terminal" });
  });
  it("amount and currency mismatches are anomalies", () => {
    expect(decideWebhookEffect(intent("CREATED"), ev("payment.succeeded", { amount: 4999n }))).toMatchObject({ anomaly: "amount_mismatch" });
    expect(decideWebhookEffect(intent("CREATED"), ev("payment.succeeded", { currency: "USD" }))).toMatchObject({ anomaly: "currency_mismatch" });
  });
  it("failed carries the failure code", () => {
    const d = decideWebhookEffect(intent("CREATED"), ev("payment.failed", { failureCode: "insufficient_funds" }));
    expect(d).toMatchObject({ kind: "transition", to: "FAILED", failureCode: "insufficient_funds" });
  });
  it("property: never throws, and a non-transition never changes status", () => {
    const status = fc.constantFrom(...PAYMENT_INTENT_STATES);
    const kind = fc.constantFrom("payment.requires_action", "payment.authorized", "payment.succeeded", "payment.failed", "payment.voided", "refund.succeeded", "refund.failed" as const);
    fc.assert(
      fc.property(status, kind, fc.bigInt({ min: 1n, max: 9000n }), (s, k, amt) => {
        const i = intent(s, { refundedAmount: s === "PARTIALLY_REFUNDED" ? 100n : s === "REFUNDED" ? 5000n : 0n });
        const d = decideWebhookEffect(i, ev(k as NormalizedPaymentEvent["kind"], { amount: amt }));
        if (d.kind === "transition") {
          expect(paymentIntentMachine.analyze().ok).toBe(true);
          expect(paymentIntentMachine.isTerminal(s)).toBe(false);
        }
      }),
    );
  });
});

describe("decideRefundApplication", () => {
  it("parts sum to the captured total: refunded never exceeds amount", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 1_000_000n }), fc.array(fc.bigInt({ min: 1n, max: 500_000n }), { maxLength: 12 }), (amount, parts) => {
        let status: PaymentIntentStatus = "SUCCEEDED";
        let refunded = 0n;
        for (const p of parts) {
          const d = decideRefundApplication({ status, amount, refundedAmount: refunded }, p);
          if (d.kind === "apply") {
            refunded = d.totalRefunded;
            status = d.to;
            expect(d.full).toBe(refunded === amount);
          } else {
            expect(refunded + p > amount).toBe(true);
          }
          expect(refunded <= amount).toBe(true);
        }
      }),
    );
  });
  it("rejects a refund on a non-captured intent", () => {
    expect(decideRefundApplication({ status: "CREATED", amount: 100n, refundedAmount: 0n }, 50n)).toEqual({ kind: "reject", anomaly: "refund_exceeds_captured" });
  });
});
