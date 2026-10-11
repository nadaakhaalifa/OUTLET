import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { InvalidSagaTransitionError } from "./errors";
import {
  beginCompensation,
  canReviveForLatePayment,
  finishCompensation,
  initialFacts,
  isTerminal,
  nextAction,
  pendingCompensations,
  reviveForLatePayment,
  type SagaFacts,
} from "./saga";
import type { CheckoutMethod } from "./types";

const NOW = 1_000_000;

/** Executes one action the way a perfect runner would. `stock` decides claim outcomes. */
function apply(f: SagaFacts, nowMs: number, opts: { stock: boolean }): SagaFacts {
  const a = nextAction(f, nowMs);
  switch (a.kind) {
    case "validate":
      return { ...f, status: "RESERVE_INVENTORY" };
    case "reserve":
      return { ...f, reservationId: "r", reservationExpiresAtMs: NOW + 600_000 };
    case "hold_credit":
      return { ...f, holdId: "h", holdReleased: false };
    case "create_intent":
      return { ...f, intentId: "i" };
    case "advance":
      return { ...f, status: a.to };
    case "claim":
      return opts.stock ? { ...f, claimed: true } : beginCompensation(f, "late_payment_no_stock");
    case "post_ledger":
      return { ...f, ledgerPosted: true };
    case "place_orders":
      return { ...f, ordersPlaced: true };
    case "capture_credit":
      return { ...f, holdCaptured: true };
    case "mark_placed":
      return { ...f, status: "PLACED" };
    case "begin_compensation":
      return beginCompensation(f, a.reason);
    case "compensate":
      switch (a.step) {
        case "refund_payment":
          return { ...f, refunded: true };
        case "void_intent":
          return { ...f, intentVoided: true };
        case "reverse_ledger":
          return { ...f, ledgerReversed: true };
        case "release_hold":
          return { ...f, holdReleased: true };
        case "release_reservation":
          return { ...f, reservationReleased: true };
      }
      return f;
    case "finish_compensation":
      return finishCompensation(f);
    case "wait":
    case "none":
      return f;
  }
}

const start = (method: CheckoutMethod, credit: bigint, ext: bigint, codConfirm = false) =>
  initialFacts({ method, creditAmount: credit, externalDue: ext, codNeedsConfirmation: codConfirm });

function run(f0: SagaFacts, opts: { stock: boolean }, at: (f: SagaFacts) => number = () => NOW): SagaFacts {
  let f = f0;
  for (let i = 0; i < 60; i += 1) {
    const next = apply(f, at(f), opts);
    if (next === f) return f;
    f = next;
  }
  throw new Error("did not converge");
}

describe("checkout saga facts", () => {
  it("walks card + credit to AWAIT_PAYMENT and waits for the webhook", () => {
    const f = run(start("card", 500n, 1500n), { stock: true });
    expect(f.status).toBe("AWAIT_PAYMENT");
    expect(f.holdId).toBe("h");
    expect(f.intentId).toBe("i");
    expect(nextAction(f, NOW)).toEqual({ kind: "wait", wakeAtMs: NOW + 600_000 });
  });

  it("skips hold and intent when nothing needs them, and goes straight to claiming", () => {
    const f = run(start("card", 0n, 0n), { stock: true });
    expect(f.status).toBe("PLACED");
    expect(f.holdId).toBeNull();
    expect(f.intentId).toBeNull();
    expect(f.ledgerPosted).toBe(true);
  });

  it("COD places without an intent and without a ledger posting", () => {
    const f = run(start("cod", 0n, 9900n), { stock: true });
    expect(f.status).toBe("PLACED");
    expect(f.intentId).toBeNull();
    expect(f.ledgerPosted).toBe(false);
  });

  it("COD with risk confirmation waits until confirmed", () => {
    const w = run(start("cod", 0n, 9900n, true), { stock: true });
    expect(w.status).toBe("AWAIT_PAYMENT");
    const done = run({ ...w, codConfirmation: "confirmed" }, { stock: true });
    expect(done.status).toBe("PLACED");
  });

  it("webhook before redirect: success recorded early is consumed without creating an intent twice", () => {
    let f = run(start("card", 0n, 1000n), { stock: true });
    f = { ...f, payment: "succeeded" };
    expect(run(f, { stock: true }).status).toBe("PLACED");
  });

  it("payment failure compensates in order and ends FAILED with nothing leaked", () => {
    let f = run(start("card", 500n, 1500n), { stock: true });
    f = { ...f, payment: "failed" };
    expect(nextAction(f, NOW)).toEqual({ kind: "begin_compensation", reason: "payment_failed" });
    f = run(f, { stock: true });
    expect(f.status).toBe("FAILED");
    expect(f.intentVoided && f.holdReleased && f.reservationReleased).toBe(true);
  });

  it("expiry compensates to EXPIRED, then a late success revives and claims", () => {
    let f = run(start("card", 500n, 1500n), { stock: true });
    f = run(f, { stock: true }, () => NOW + 700_000);
    expect(f.status).toBe("EXPIRED");
    f = { ...f, payment: "succeeded" };
    expect(canReviveForLatePayment(f)).toBe(true);
    f = reviveForLatePayment(f);
    expect(f.status).toBe("HOLD_CREDIT");
    f = run(f, { stock: true }, () => NOW + 700_000);
    expect(f.status).toBe("PLACED");
    expect(f.holdCaptured).toBe(true);
  });

  it("late success with no stock ends REFUNDED after refund and releases everything", () => {
    let f = run(start("card", 0n, 1500n), { stock: true });
    f = run(f, { stock: true }, () => NOW + 700_000);
    f = reviveForLatePayment({ ...f, payment: "succeeded" });
    f = run(f, { stock: false }, () => NOW + 700_000);
    expect(f.status).toBe("REFUNDED");
    expect(f.refunded).toBe(true);
    expect(f.reservationReleased).toBe(true);
    expect(f.ordersPlaced).toBe(false);
  });

  it("a revived saga re-holds credit under a fresh hold id generation", () => {
    let f = start("card", 100n, 900n);
    f = run(f, { stock: true }, () => NOW);
    expect(f.holdSeq).toBe(0);
    f = beginCompensation(f, "payment_window_elapsed");
    f = run(f, { stock: true }, () => NOW);
    expect(f.status).toBe("EXPIRED");
    const revived = reviveForLatePayment({ ...f, payment: "succeeded" });
    expect(revived.status).toBe("HOLD_CREDIT");
    expect(revived.holdSeq).toBe(1);
    expect(revived.holdId).toBeNull();
  });

  it("refuses to compensate once orders are placed and cannot revive a cancelled saga", () => {
    const placed = run(start("card", 0n, 0n), { stock: true });
    expect(() => beginCompensation(placed, "payment_failed")).toThrow(InvalidSagaTransitionError);
    const c = run(beginCompensation(run(start("card", 0n, 1000n), { stock: true }), "cancelled_by_shopper"), { stock: true });
    expect(c.status).toBe("CANCELLED");
    expect(canReviveForLatePayment({ ...c, payment: "succeeded" })).toBe(false);
  });

  it("property: any interleaving of payment result and time ends terminal with no leaked resource", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<CheckoutMethod>("card", "cod", "fawry", "bnpl", "mobile_wallet"),
        fc.bigInt({ min: 0n, max: 5000n }),
        fc.bigInt({ min: 0n, max: 5000n }),
        fc.constantFrom<"none" | "succeeded" | "failed">("none", "succeeded", "failed"),
        fc.integer({ min: 0, max: 40 }), // step at which the payment result arrives
        fc.integer({ min: 0, max: 40 }), // step at which time jumps past expiry
        fc.integer({ min: 0, max: 40 }), // step at which the shopper cancels
        fc.boolean(),
        (method, credit, ext, pay, payAt, expireAt, cancelAt, stock) => {
          let f = start(method, method === "cod" ? 0n : credit, ext);
          let now = NOW;
          for (let i = 0; i < 90; i += 1) {
            if (i === payAt && pay !== "none" && f.intentId !== null && !isTerminal(f.status)) f = { ...f, payment: pay };
            if (i === expireAt) now = NOW + 90_000_000;
            if (i === cancelAt && f.status !== "PLACED" && f.status !== "COMPENSATING" && !isTerminal(f.status) && !f.ordersPlaced) {
              f = beginCompensation(f, "cancelled_by_shopper");
            }
            const n = apply(f, now, { stock });
            if (n === f) {
              if (f.status === "AWAIT_PAYMENT" && f.payment === "none") now = NOW + 90_000_000;
              else break;
            }
            f = n;
          }
          expect(isTerminal(f.status)).toBe(true);
          if (f.status === "PLACED") {
            expect(f.claimed && f.ordersPlaced).toBe(true);
            expect(f.holdId === null || f.holdCaptured).toBe(true);
            if (f.payment === "none" && f.externalDue > 0n && f.method !== "cod") throw new Error("placed unpaid");
          } else {
            expect(pendingCompensations(f)).toEqual([]);
            expect(f.ordersPlaced).toBe(false);
            expect(f.holdId === null || f.holdReleased).toBe(true);
            expect(f.reservationId === null || f.reservationReleased).toBe(true);
            expect(!f.ledgerPosted || f.ledgerReversed).toBe(true);
            // money received is always sent back
            expect(f.payment !== "succeeded" || f.refunded).toBe(true);
          }
        },
      ),
      { numRuns: 600 },
    );
  });
});
