import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { accrualGate } from "./accrual-gate";
import { commissionOn, eligibleBase, refundedBaseOf } from "./commission";

describe("accrualGate", () => {
  const base = { nowMs: 1_000, returnWindowEndsAtMs: 1_000, openReturns: 0 };
  it("opens exactly at the window end, never before", () => {
    expect(accrualGate(base)).toBe("ok");
    expect(accrualGate({ ...base, nowMs: 999 })).toBe("window_open");
  });
  it("an open return blocks even after the window", () => {
    expect(accrualGate({ ...base, nowMs: 9_999, openReturns: 1 })).toBe("return_open");
  });
  it("unknown or malformed facts fail closed", () => {
    expect(accrualGate({ ...base, returnWindowEndsAtMs: null })).toBe("facts_unknown");
    expect(accrualGate({ ...base, openReturns: null })).toBe("facts_unknown");
    expect(accrualGate({ ...base, openReturns: -1 })).toBe("facts_unknown");
    expect(accrualGate({ ...base, returnWindowEndsAtMs: 1.5 })).toBe("facts_unknown");
    expect(accrualGate({ ...base, openReturns: 0.5 })).toBe("facts_unknown");
  });
  it("property: ok implies window elapsed and no open return; any longer seller window defers", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e9 }), fc.integer({ min: 0, max: 1e9 }), fc.integer({ min: 0, max: 3 }), (now, end, open) => {
        const v = accrualGate({ nowMs: now, returnWindowEndsAtMs: end, openReturns: open });
        expect(v === "ok").toBe(now >= end && open === 0);
      }),
    );
  });
  it("property: whenever the gate is ok the accrued amount never exceeds commission on the never-refunded base", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        fc.bigInt({ min: 0n, max: 3_000n }),
        (gross, refunded, rate) => {
          const base0 = eligibleBase({ merchandiseGross: gross, voucherAllocated: 0n, vatBps: 1400n });
          const refundedBase = refundedBaseOf(base0, gross, refunded > gross ? gross : refunded);
          expect(commissionOn(base0 - refundedBase, rate)).toBeLessThanOrEqual(commissionOn(base0, rate));
        },
      ),
    );
  });
});
