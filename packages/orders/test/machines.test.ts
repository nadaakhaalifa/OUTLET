import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ORDER_GROUP, OrderStateError, PAYMENT_INTENT, SELLER_ORDER, can, reachable, transition } from "../src/index.js";
import type { Machine } from "../src/index.js";

const machines: readonly Machine<string, string>[] = [ORDER_GROUP, SELLER_ORDER, PAYMENT_INTENT];

describe.each(machines.map((m) => [m.name, m] as const))("%s machine", (_name, m) => {
  it("every state is reachable from the initial state and every target is a declared state", () => {
    expect([...reachable(m)].sort()).toEqual([...m.states].sort());
    for (const s of m.states) for (const next of Object.values(m.table[s] ?? {})) expect(m.states).toContain(next);
  });

  it("terminal states have no outgoing edge; every non-terminal state has one", () => {
    for (const s of m.states) expect(Object.keys(m.table[s] ?? {}).length === 0).toBe(m.terminal.includes(s));
  });

  it("property: random event sequences never leave the declared state set; invalid events throw a typed error", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...m.events), { maxLength: 40 }), (events) => {
        let s = m.initial;
        for (const e of events) {
          if (can(m, s, e)) s = transition(m, s, e);
          else expect(() => transition(m, s, e)).toThrow(OrderStateError);
          expect(m.states).toContain(s);
        }
      }),
      { numRuns: 1000 },
    );
  });
});

describe("spec edges", () => {
  it("a late payment after expiry or failure is claimed or refunded, never silently dropped", () => {
    expect(transition(ORDER_GROUP, "EXPIRED", "late_payment_claimed")).toBe("PAID");
    expect(transition(ORDER_GROUP, "PAYMENT_FAILED", "late_payment_unavailable")).toBe("REFUND_PENDING");
    expect(transition(PAYMENT_INTENT, "CANCELLED", "late_capture")).toBe("CAPTURED");
  });
  it("a seller order cannot be cancelled after SHIPPED (refusal or return instead)", () => {
    expect(() => transition(SELLER_ORDER, "SHIPPED", "cancel")).toThrow(/cannot cancel from SHIPPED/);
  });
});
