import { describe, expect, it } from "vitest";
import { InvalidTransitionError, SELLER_ORDER_STATES, type SellerOrderState } from "../state-machine";
import { buyerAccessOpen, buyerViewForSeller } from "./buyer-view";
import { AcceptWindowElapsedError, NotCancellableError, ReturnsOpenError } from "./errors";
import {
  acceptDeadline,
  acceptWindowOpen,
  closeAfterMsForWindowDays,
  decideAccept,
  decideAcceptSlaExpiry,
  decideCancel,
  decideClose,
  decideDeliver,
  decideOutForDelivery,
  decidePack,
  decideReject,
  decideShip,
  dispatchDeadline,
  isCancellable,
  refundRequired,
} from "./lifecycle";
import { rollupOrderGroup } from "./rollup";
import { ACCEPT_SLA_MS, BUYER_ACCESS_GRACE_MS, DAY_MS, DISPATCH_SLA_MS, SHOPPER_CANCELLABLE } from "./types";
import type { OrderFacts } from "./types";

const T = 1_800_000_000_000;
const order = (status: SellerOrderState, over: Partial<OrderFacts> = {}): OrderFacts => ({
  status,
  paymentType: "prepaid",
  acceptByMs: T + ACCEPT_SLA_MS,
  ...over,
});

describe("deadlines", () => {
  it("accept_by is paid_at + 24h and dispatch_by is accepted_at + 48h", () => {
    expect(acceptDeadline(T)).toBe(T + 86_400_000);
    expect(dispatchDeadline(T)).toBe(T + 172_800_000);
    expect(DISPATCH_SLA_MS).toBe(2 * DAY_MS);
  });
  it("window is open strictly before accept_by", () => {
    expect(acceptWindowOpen(order("PAID"), T + ACCEPT_SLA_MS - 1)).toBe(true);
    expect(acceptWindowOpen(order("PAID"), T + ACCEPT_SLA_MS)).toBe(false);
    expect(acceptWindowOpen(order("PAID", { acceptByMs: null }), T + 10 * DAY_MS)).toBe(true);
  });
});

describe("seller commands", () => {
  it("accepts PAID and CONFIRMED_COD and freezes dispatch_by", () => {
    for (const s of ["PAID", "CONFIRMED_COD"] as const) {
      const t = decideAccept(order(s), T + 1000);
      expect(t.to).toBe("ACCEPTED");
      expect(t.stamps).toEqual({ acceptedAtMs: T + 1000, dispatchByMs: T + 1000 + DISPATCH_SLA_MS });
      expect(t.actorType).toBe("SELLER");
    }
  });
  it("refuses accept at the deadline instant", () => {
    expect(() => decideAccept(order("PAID"), T + ACCEPT_SLA_MS)).toThrow(AcceptWindowElapsedError);
    expect(decideAccept(order("PAID"), T + ACCEPT_SLA_MS - 1).to).toBe("ACCEPTED");
  });
  it("accept on an already accepted order is an invalid transition, not a window error", () => {
    expect(() => decideAccept(order("ACCEPTED"), T + ACCEPT_SLA_MS + 5)).toThrow(InvalidTransitionError);
  });
  it("packs only ACCEPTED, ships only PACKED", () => {
    expect(decidePack(order("ACCEPTED"), T).to).toBe("PACKED");
    expect(() => decidePack(order("PAID"), T)).toThrow(InvalidTransitionError);
    expect(decideShip(order("PACKED"), T).to).toBe("SHIPPED");
    expect(decideShip(order("PACKED"), T).actorType).toBe("COURIER");
    expect(() => decideShip(order("ACCEPTED"), T)).toThrow(InvalidTransitionError);
  });
  it("rejects PAID, CONFIRMED_COD and ACCEPTED with a reason, never after PACKED", () => {
    for (const s of ["PAID", "CONFIRMED_COD", "ACCEPTED"] as const) {
      const t = decideReject(order(s), "out_of_stock", T);
      expect(t.to).toBe("REJECTED_BY_SELLER");
      expect(t.rejectReason).toBe("out_of_stock");
      expect(t.reasonCode).toBe("out_of_stock");
    }
    for (const s of ["PACKED", "SHIPPED", "CANCELLED"] as const) {
      expect(() => decideReject(order(s), "other", T)).toThrow(InvalidTransitionError);
    }
  });
});

describe("cancellation", () => {
  it("is allowed exactly in SHOPPER_CANCELLABLE states and refused elsewhere", () => {
    for (const s of SELLER_ORDER_STATES) {
      if (SHOPPER_CANCELLABLE.includes(s)) {
        const t = decideCancel(order(s), "SHOPPER", "changed_mind", T);
        expect(t.to).toBe("CANCELLED");
        expect(t.cancelInitiator).toBe("SHOPPER");
        expect(isCancellable(s)).toBe(true);
      } else {
        expect(() => decideCancel(order(s), "SHOPPER", "changed_mind", T)).toThrow(NotCancellableError);
        expect(isCancellable(s)).toBe(false);
      }
    }
  });
  it("maps initiators to actor types", () => {
    expect(decideCancel(order("PAID"), "ADMIN", "x", T).actorType).toBe("ADMIN");
    expect(decideCancel(order("PAID"), "RISK", "x", T).actorType).toBe("SYSTEM");
  });
  it("SLA expiry only fires for unaccepted orders past accept_by", () => {
    expect(decideAcceptSlaExpiry(order("PAID"), T + ACCEPT_SLA_MS - 1)).toBeNull();
    const t = decideAcceptSlaExpiry(order("CONFIRMED_COD"), T + ACCEPT_SLA_MS);
    expect(t?.to).toBe("CANCELLED");
    expect(t?.cancelInitiator).toBe("SYSTEM_TIMEOUT");
    expect(t?.reasonCode).toBe("accept_sla_expired");
    expect(decideAcceptSlaExpiry(order("ACCEPTED"), T + 9 * DAY_MS)).toBeNull();
    expect(decideAcceptSlaExpiry(order("PAID", { acceptByMs: null }), T + 9 * DAY_MS)).toBeNull();
  });
  it("refund hint: prepaid only, never before payment", () => {
    expect(refundRequired(order("PAID"))).toBe(true);
    expect(refundRequired(order("CONFIRMED_COD", { paymentType: "cod" }))).toBe(false);
    expect(refundRequired(order("PENDING_PAYMENT"))).toBe(false);
  });
});

describe("buyer view for sellers", () => {
  const c = { firstName: "Mona", phoneRelay: "+20100000099", governorateCode: "EG-C" };
  const acc = (status: SellerOrderState, deliveredAtMs: number | null = null, closedAtMs: number | null = null) => ({
    status,
    deliveredAtMs,
    closedAtMs,
  });
  it("shows only the governorate before acceptance", () => {
    expect(buyerViewForSeller(c, acc("PAID"), T)).toEqual({ governorateCode: "EG-C", addressVisible: false });
  });
  it("shows first name and relay once accepted, never the raw phone", () => {
    expect(buyerViewForSeller(c, acc("ACCEPTED"), T)).toEqual({
      governorateCode: "EG-C",
      firstName: "Mona",
      phoneRelay: "+20100000099",
      addressVisible: true,
    });
  });
  it("omits fields the contact does not have", () => {
    const v = buyerViewForSeller({ firstName: null, phoneRelay: null, governorateCode: "EG-C" }, acc("PACKED"), T);
    expect(v).toEqual({ governorateCode: "EG-C", addressVisible: true });
  });
  it("hides everything for dead orders", () => {
    for (const s of ["CANCELLED", "REJECTED_BY_SELLER", "CLOSED", "REFUNDED"] as const) {
      expect(buyerAccessOpen(acc(s), T)).toBe(false);
    }
  });
  it("closes 30 days after delivery, or after closure when later", () => {
    const delivered = T;
    expect(buyerAccessOpen(acc("DELIVERED", delivered), delivered + BUYER_ACCESS_GRACE_MS - 1)).toBe(true);
    expect(buyerAccessOpen(acc("DELIVERED", delivered), delivered + BUYER_ACCESS_GRACE_MS)).toBe(false);
    const closed = delivered + 20 * DAY_MS;
    expect(buyerAccessOpen(acc("RETURN_REQUESTED", delivered, closed), delivered + BUYER_ACCESS_GRACE_MS)).toBe(true);
    expect(buyerAccessOpen(acc("RETURN_REQUESTED", delivered, closed), closed + BUYER_ACCESS_GRACE_MS)).toBe(false);
  });
});

describe("rollupOrderGroup", () => {
  it("starts fulfilment on the first accepted seller order", () => {
    expect(rollupOrderGroup("PAID", ["ACCEPTED", "PAID"])).toEqual({ event: "FULFILMENT_STARTED", to: "FULFILLING" });
    expect(rollupOrderGroup("CONFIRMED_COD", ["PACKED"])?.to).toBe("FULFILLING");
  });
  it("does nothing while nothing started, or when already fulfilling", () => {
    expect(rollupOrderGroup("PAID", ["PAID", "CONFIRMED_COD"])).toBeNull();
    expect(rollupOrderGroup("FULFILLING", ["ACCEPTED", "PAID"])).toBeNull();
  });
  it("cancels the group only when every seller order is dead", () => {
    expect(rollupOrderGroup("PAID", ["CANCELLED", "REJECTED_BY_SELLER"])?.to).toBe("CANCELLED");
    expect(rollupOrderGroup("FULFILLING", ["CANCELLED", "ACCEPTED"])).toBeNull();
    expect(rollupOrderGroup("FULFILLING", ["CANCELLED", "CANCELLED"])?.to).toBe("CANCELLED");
  });
  it("is null for an empty or terminal group", () => {
    expect(rollupOrderGroup("PAID", [])).toBeNull();
    expect(rollupOrderGroup("CANCELLED", ["CANCELLED"])).toBeNull();
  });
});

import { money } from "../money";
import { assertValidIntake, commissionFor } from "./intake";
import { InvalidOrderIntakeError } from "./errors";

describe("intake validation", () => {
  const lines = [
    { qty: 2, unitPrice: money(10_000n) },
    { qty: 1, unitPrice: money(5_000n) },
  ];
  const ok = { subtotal: money(25_000n), shipping: money(4_000n), discount: money(1_000n), total: money(28_000n) };
  it("accepts consistent totals", () => {
    expect(() => assertValidIntake(lines, ok)).not.toThrow();
  });
  it("rejects empty, bad qty, wrong subtotal, wrong total, negatives", () => {
    expect(() => assertValidIntake([], ok)).toThrow(InvalidOrderIntakeError);
    expect(() => assertValidIntake([{ qty: 0, unitPrice: money(1n) }], ok)).toThrow(InvalidOrderIntakeError);
    expect(() => assertValidIntake(lines, { ...ok, subtotal: money(24_999n) })).toThrow(/subtotal/);
    expect(() => assertValidIntake(lines, { ...ok, total: money(28_001n) })).toThrow(/total/);
    expect(() => assertValidIntake(lines, { ...ok, discount: money(-1n), total: money(29_001n) })).toThrow(InvalidOrderIntakeError);
  });
  it("commission uses banker's rounding at the single point", () => {
    expect(commissionFor(money(10_000n), 1_500).amount).toBe(1_500n);
    expect(commissionFor(money(5n), 1_000).amount).toBe(0n); // 0.5 rounds to even 0
    expect(commissionFor(money(15n), 1_000).amount).toBe(2n); // 1.5 rounds to even 2
    expect(() => commissionFor(money(1n), 10_001)).toThrow(InvalidOrderIntakeError);
  });
});

describe("delivery and closure decisions", () => {
  const DAY = 86_400_000;
  const base = { paymentType: "prepaid", acceptByMs: null } as const;

  it("SHIPPED passes through OUT_FOR_DELIVERY; DELIVER stamps the courier-confirmed time", () => {
    const ofd = decideOutForDelivery({ ...base, status: "SHIPPED" });
    expect(ofd).toMatchObject({ from: "SHIPPED", to: "OUT_FOR_DELIVERY", actorType: "COURIER" });
    const d = decideDeliver({ ...base, status: "OUT_FOR_DELIVERY" }, 1_234);
    expect(d).toMatchObject({ to: "DELIVERED", stamps: { deliveredAtMs: 1_234 } });
    expect(() => decideDeliver({ ...base, status: "SHIPPED" }, 1)).toThrow();
    expect(() => decideDeliver({ ...base, status: "PACKED" }, 1)).toThrow();
  });

  it("close happens only for DELIVERED once the window has elapsed, never earlier and never from other states", () => {
    const o = { ...base, status: "DELIVERED", deliveredAtMs: 1_000 } as const;
    const after = 33 * DAY;
    expect(decideClose(o, 1_000 + after - 1, after)).toBeNull();
    expect(decideClose(o, 1_000 + after, after)).toMatchObject({ to: "CLOSED", event: "CLOSE", stamps: { closedAtMs: 1_000 + after } });
    expect(decideClose({ ...o, deliveredAtMs: null }, 1e15, after)).toBeNull();
    for (const status of ["SHIPPED", "CANCELLED", "CLOSED", "RETURN_REQUESTED", "REFUNDED"] as const) {
      expect(decideClose({ ...o, status }, 1e15, after)).toBeNull();
    }
  });
});

describe("closure return gate (A-9)", () => {
  const base = { ...({ status: "DELIVERED", paymentType: "prepaid", acceptByMs: null } as const), deliveredAtMs: 0 };
  it("closeAfterMsForWindowDays: integer days, floor 30, +3 margin, fail to floor", () => {
    const D = 86_400_000;
    expect(closeAfterMsForWindowDays(null)).toBe(33 * D);
    expect(closeAfterMsForWindowDays(7)).toBe(33 * D);
    expect(closeAfterMsForWindowDays(45)).toBe(48 * D);
    expect(closeAfterMsForWindowDays(45.5)).toBe(33 * D);
    expect(closeAfterMsForWindowDays(-1)).toBe(33 * D);
  });
  it("throws ReturnsOpenError while a return is open; closes when none", () => {
    const D = 86_400_000;
    expect(() => decideClose({ ...base, openReturns: 1 }, 40 * D, 33 * D)).toThrow(ReturnsOpenError);
    expect(decideClose({ ...base, openReturns: 0 }, 40 * D, 33 * D)?.to).toBe("CLOSED");
    expect(decideClose({ ...base, openReturns: 1 }, 10 * D, 33 * D)).toBeNull();
  });
});
