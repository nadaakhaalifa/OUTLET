// Table test for the commission state machine. The machine validates itself at import time, so a mutant
// that corrupts the table throws while the module loads. Loading it inside each test (dynamic import)
// turns that crash into a failing test, which is what Stryker counts as a kill.
import { describe, expect, it } from "vitest";

type S = "ACCRUING" | "ACCRUED" | "PAID" | "CLAWED_BACK" | "VOIDED";
type E = "ACCRUE" | "PAY" | "CLAWBACK_ALL" | "VOID";
const load = () => import("./machine");

describe("commission machine table", () => {
  const T: Record<S, Partial<Record<E, S>>> = {
    ACCRUING: { ACCRUE: "ACCRUED", VOID: "VOIDED" },
    ACCRUED: { PAY: "PAID", CLAWBACK_ALL: "CLAWED_BACK" },
    PAID: { CLAWBACK_ALL: "CLAWED_BACK" },
    CLAWED_BACK: {},
    VOIDED: {},
  };
  it("every state x event pair", async () => {
    const { COMMISSION_EVENTS, COMMISSION_STATES, transitionCommission } = await load();
    expect([...COMMISSION_STATES]).toEqual(["ACCRUING", "ACCRUED", "PAID", "CLAWED_BACK", "VOIDED"]);
    expect([...COMMISSION_EVENTS]).toEqual(["ACCRUE", "PAY", "CLAWBACK_ALL", "VOID"]);
    for (const s of COMMISSION_STATES) {
      for (const e of COMMISSION_EVENTS) {
        const want = T[s][e];
        if (want === undefined) expect(() => transitionCommission(s, e), `${s} ${e}`).toThrow();
        else expect(transitionCommission(s, e), `${s} ${e}`).toBe(want);
      }
    }
  });
  it("metadata", async () => {
    const { commissionMachine } = await load();
    expect(commissionMachine.name).toBe("Commission");
    expect(commissionMachine.initial).toBe("ACCRUING");
    expect([...commissionMachine.terminalStates].sort()).toEqual(["CLAWED_BACK", "VOIDED"]);
  });
});
