import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DomainError } from "../errors";
import {
  GuardRejectedError,
  InvalidTransitionError,
  MachineDefinitionError,
  UnknownEventError,
  UnknownStateError,
} from "./errors";
import { defineMachine, guard, type StateMachine } from "./machine";
import { stateMachines, type StateMachineKey } from "./registry";
import { sellerOrderMachine } from "./machines/seller-order";

type Ctx = Record<string, boolean | number>;

/** Context candidates per machine, covering every guard outcome. */
function bools(keys: readonly string[]): Ctx[] {
  let out: Ctx[] = [{}];
  for (const k of keys) out = out.flatMap((c) => [{ ...c, [k]: true }, { ...c, [k]: false }]);
  return out;
}
const attempts = (key: string, ctxs: Ctx[]): Ctx[] =>
  [0, 2, 3, 4].flatMap((n) => ctxs.map((c) => ({ ...c, [key]: n })));

const contexts: Record<StateMachineKey, Ctx[]> = {
  orderGroup: bools(["stockAvailable"]),
  sellerOrder: attempts("deliveryAttempts", bools(["returnWindowElapsed"])),
  shipment: attempts("attemptsMade", bools(["cod"])),
  return: bools(["rejectionPhotosAttached", "inspectionSlaElapsed"]),
  refund: attempts("attempts", [{}]),
  payout: bools(["approvalRequirementMet", "noOpenDispute", "ibanNameMatched"]),
  subscription: [{}],
  drop: [{}],
  priceClaim: [{}],
  giftCard: bools(["potFunded", "expiryReached"]),
  kyc: bools(["documentsValid", "sanctionsClear", "signatoryAdult21"]),
  dispute: bools(["decidedByHuman"]),
  priceDropAutoBuy: bools([
    "verifiedPriceAtOrBelowTarget",
    "plusActive",
    "withinBudget",
    "eligiblePaymentMethod",
    "cancelWindowElapsed",
  ]),
};

// The registry mixes context types; tests drive machines through a loosely typed view.
interface LooseMachine {
  readonly name: string;
  readonly states: readonly string[];
  readonly events: readonly string[];
  readonly initial: string;
  readonly terminalStates: readonly string[];
  analyze(): ReturnType<StateMachine<string, string, undefined>["analyze"]>;
  edges(): readonly { from: string; event: string; to: string; guard: string | undefined }[];
  availableEvents(state: string): readonly string[];
  transition(state: string, event: string, ctx?: Ctx): string;
  can(state: string, event: string, ctx?: Ctx): boolean;
}
const loose = (m: unknown): LooseMachine => m as LooseMachine;
const keys = Object.keys(stateMachines) as StateMachineKey[];

describe("the 13 machines of spec A2.6 are all present", () => {
  it("has exactly the named machines", () => {
    expect(keys).toHaveLength(13);
    expect(keys.map((k) => stateMachines[k].name).sort()).toEqual(
      [
        "OrderGroup",
        "SellerOrder",
        "Shipment",
        "Return",
        "Refund",
        "Payout",
        "Subscription",
        "Drop",
        "PriceClaim",
        "GiftCard",
        "KYC",
        "Dispute",
        "PriceDropAutoBuy",
      ].sort(),
    );
  });
});

describe.each(keys)("%s", (key) => {
  const m = loose(stateMachines[key]);
  const ctxs = contexts[key];

  it("passes static analysis: no unreachable states, no dead ends, terminals are final", () => {
    const a = m.analyze();
    expect(a.unreachable).toEqual([]);
    expect(a.deadEnds).toEqual([]);
    expect(a.terminalsWithOutgoing).toEqual([]);
    expect(a.ok).toBe(true);
  });

  it("has at least one terminal state and every terminal is reachable", () => {
    expect(m.terminalStates.length).toBeGreaterThan(0);
    const reachable = new Set(m.analyze().reachable);
    for (const t of m.terminalStates) expect(reachable.has(t)).toBe(true);
  });

  it("every declared transition is legal (guarded ones for a passing context)", () => {
    for (const e of m.edges()) {
      if (e.guard === undefined) {
        expect(m.transition(e.from, e.event, ctxs[0])).toBe(e.to);
      } else {
        const passing = ctxs.filter((c) => m.can(e.from, e.event, c));
        expect(passing.length, `${e.from} --${e.event}--> needs a passing context`).toBeGreaterThan(0);
        for (const c of passing) expect(m.transition(e.from, e.event, c)).toBe(e.to);
      }
    }
  });

  it("every guarded transition is rejected with GuardRejectedError for a failing context", () => {
    for (const e of m.edges().filter((x) => x.guard !== undefined)) {
      const failing = ctxs.filter((c) => !m.can(e.from, e.event, c));
      expect(failing.length, `${e.from} --${e.event}--> needs a failing context`).toBeGreaterThan(0);
      for (const c of failing) {
        expect(() => m.transition(e.from, e.event, c)).toThrow(GuardRejectedError);
      }
    }
  });

  it("every undeclared (state, event) pair throws InvalidTransitionError", () => {
    const declared = new Set(m.edges().map((e) => `${e.from}|${e.event}`));
    let checked = 0;
    for (const s of m.states) {
      for (const ev of m.events) {
        if (declared.has(`${s}|${ev}`)) continue;
        for (const c of ctxs) {
          expect(() => m.transition(s, ev, c)).toThrow(InvalidTransitionError);
          expect(m.can(s, ev, c)).toBe(false);
        }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("terminal states accept no event at all", () => {
    for (const t of m.terminalStates) expect(m.availableEvents(t)).toEqual([]);
  });

  it("rejects unknown states and events with typed errors", () => {
    expect(() => m.transition("NOPE", m.events[0] ?? "", ctxs[0])).toThrow(UnknownStateError);
    expect(() => m.transition(m.initial, "NOPE", ctxs[0])).toThrow(UnknownEventError);
  });

  it("property: arbitrary event sequences never leave the state set or escape a terminal", () => {
    const states = new Set(m.states);
    const terminal = new Set(m.terminalStates);
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            event: fc.constantFrom(...m.events),
            ctx: fc.constantFrom(...ctxs),
          }),
          { maxLength: 60 },
        ),
        (steps) => {
          let state = m.initial;
          for (const { event, ctx } of steps) {
            const wasTerminal = terminal.has(state);
            try {
              state = m.transition(state, event, ctx);
              if (wasTerminal) return false;
            } catch (err) {
              if (!(err instanceof DomainError)) return false;
            }
            if (!states.has(state)) return false;
          }
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });

  it("property: from any reachable state a terminal is reachable by declared edges", () => {
    const a = m.analyze();
    expect(a.deadEnds).toHaveLength(0);
  });
});

describe("SellerOrder per spec 20.1", () => {
  const ctx = { returnWindowElapsed: false, deliveryAttempts: 0 };
  it("walks the main prepaid path to CLOSED", () => {
    let s = sellerOrderMachine.initial;
    const steps = [
      ["PAYMENT_SUCCEEDED", "PAID"],
      ["SELLER_ACCEPT", "ACCEPTED"],
      ["PACK", "PACKED"],
      ["SHIP", "SHIPPED"],
      ["OUT_FOR_DELIVERY", "OUT_FOR_DELIVERY"],
      ["DELIVER", "DELIVERED"],
    ] as const;
    for (const [ev, to] of steps) {
      s = sellerOrderMachine.transition(s, ev, ctx);
      expect(s).toBe(to);
    }
    expect(() => sellerOrderMachine.transition(s, "CLOSE", ctx)).toThrow(GuardRejectedError);
    expect(sellerOrderMachine.transition(s, "CLOSE", { ...ctx, returnWindowElapsed: true })).toBe("CLOSED");
  });

  it("walks the COD path and the full return path to REFUNDED", () => {
    const path = [
      ["COD_CONFIRMED", "CONFIRMED_COD"],
      ["SELLER_ACCEPT", "ACCEPTED"],
      ["PACK", "PACKED"],
      ["SHIP", "SHIPPED"],
      ["OUT_FOR_DELIVERY", "OUT_FOR_DELIVERY"],
      ["DELIVER", "DELIVERED"],
      ["REQUEST_RETURN", "RETURN_REQUESTED"],
      ["SCHEDULE_PICKUP", "RETURN_PICKUP_SCHEDULED"],
      ["PICKED_UP", "RETURN_IN_TRANSIT"],
      ["RECEIVE_RETURN", "RETURN_RECEIVED"],
      ["INSPECT_COMPLETE", "RETURN_INSPECTED"],
      ["REFUND_COMPLETED", "REFUNDED"],
    ] as const;
    let s = sellerOrderMachine.initial;
    for (const [ev, to] of path) {
      s = sellerOrderMachine.transition(s, ev, ctx);
      expect(s).toBe(to);
    }
  });

  it("cancellation is free before SHIPPED and impossible after", () => {
    for (const s of ["PENDING_PAYMENT", "PAID", "CONFIRMED_COD", "ACCEPTED", "PACKED"] as const) {
      expect(sellerOrderMachine.transition(s, "CANCEL", ctx)).toBe("CANCELLED");
    }
    for (const s of ["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"] as const) {
      expect(() => sellerOrderMachine.transition(s, "CANCEL", ctx)).toThrow(InvalidTransitionError);
    }
  });

  it("failed delivery retries below 3 attempts and goes RTO at 3", () => {
    expect(sellerOrderMachine.transition("DELIVERY_FAILED", "RETRY_DELIVERY", { ...ctx, deliveryAttempts: 2 })).toBe(
      "OUT_FOR_DELIVERY",
    );
    expect(() =>
      sellerOrderMachine.transition("DELIVERY_FAILED", "RETURN_TO_SELLER", { ...ctx, deliveryAttempts: 2 }),
    ).toThrow(GuardRejectedError);
    const rto = sellerOrderMachine.transition("DELIVERY_FAILED", "RETURN_TO_SELLER", { ...ctx, deliveryAttempts: 3 });
    expect(rto).toBe("RTO");
    expect(sellerOrderMachine.transition(rto, "RTO_RECEIVED", ctx)).toBe("RETURNED_TO_SELLER");
  });

  it("error carries machine, state, event and allowed events", () => {
    try {
      sellerOrderMachine.transition("CLOSED", "SHIP", ctx);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      if (err instanceof InvalidTransitionError) {
        expect(err.machine).toBe("SellerOrder");
        expect(err.from).toBe("CLOSED");
        expect(err.event).toBe("SHIP");
        expect(err.allowedEvents).toEqual([]);
      }
    }
  });
});

describe("engine definition validation and analysis", () => {
  type S = "A" | "B" | "C";
  type E = "go" | "back";
  const base = {
    name: "T",
    states: ["A", "B", "C"] as const,
    events: ["go", "back"] as const,
    initial: "A" as const,
    terminal: ["C"] as const,
  };

  it("detects unreachable and dead-end states", () => {
    const m = defineMachine<S, E>({
      ...base,
      transitions: { A: { go: { to: "B" } }, B: { back: { to: "A" } }, C: {} },
    });
    const a = m.analyze();
    expect(a.unreachable).toEqual(["C"]);
    expect(a.deadEnds).toEqual(["A", "B"]);
    expect(a.ok).toBe(false);
  });

  it("flags a terminal state with outgoing transitions", () => {
    const m = defineMachine<S, E>({
      ...base,
      transitions: { A: { go: { to: "C" } }, B: {}, C: { back: { to: "A" } } },
    });
    expect(m.analyze().terminalsWithOutgoing).toEqual(["C"]);
  });

  it("rejects bad definitions", () => {
    expect(() =>
      defineMachine<S, E>({ ...base, initial: "Z" as S, transitions: { A: {}, B: {}, C: {} } }),
    ).toThrow(MachineDefinitionError);
    expect(() =>
      defineMachine<S, E>({ ...base, transitions: { A: { go: { to: "Z" as S } }, B: {}, C: {} } }),
    ).toThrow(MachineDefinitionError);
    expect(() =>
      defineMachine<S, E>({ ...base, transitions: { A: {}, B: {} } as never }),
    ).toThrow(MachineDefinitionError);
  });

  it("supports guards over a typed context and parseState", () => {
    const m = defineMachine<S, E, { ok: boolean }>({
      ...base,
      transitions: {
        A: { go: { to: "B", guard: guard("ok", (c) => c.ok) } },
        B: { go: { to: "C" } },
        C: {},
      },
    });
    expect(m.transition("A", "go", { ok: true })).toBe("B");
    expect(() => m.transition("A", "go", { ok: false })).toThrow(GuardRejectedError);
    expect(m.parseState("B")).toBe("B");
    expect(() => m.parseState("X")).toThrow(UnknownStateError);
  });
});
