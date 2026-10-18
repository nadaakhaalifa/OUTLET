import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { planSwitch } from "./plan-switch";
import { prorationCredit, upgradeCharge } from "./billing";
import { DAY_MS } from "./types";

const monthly = { code: "plus_monthly", interval: "month" as const, priceMinor: 20_000n };
const yearly = { code: "plus_yearly", interval: "year" as const, priceMinor: 80_000n };
const family = { code: "plus_family", interval: "year" as const, priceMinor: 120_000n };
const student = { code: "plus_student", interval: "year" as const, priceMinor: 60_000n };

describe("planSwitch", () => {
  it("keeps the Phase 2 interval rules", () => {
    expect(planSwitch(monthly, yearly)).toBe("upgrade_now");
    expect(planSwitch(yearly, monthly)).toBe("downgrade_at_period_end");
    expect(planSwitch(yearly, yearly)).toBe("same");
  });
  it("same interval compares price: yearly -> family now, family -> yearly at period end", () => {
    expect(planSwitch(yearly, family)).toBe("upgrade_now");
    expect(planSwitch(family, yearly)).toBe("downgrade_at_period_end");
    expect(planSwitch(student, yearly)).toBe("upgrade_now");
    expect(planSwitch(yearly, student)).toBe("downgrade_at_period_end");
    expect(planSwitch(yearly, { ...family, priceMinor: 80_000n })).toBe("same");
  });
  it("rejects non positive prices", () => {
    expect(() => planSwitch({ ...yearly, priceMinor: 0n }, family)).toThrow();
  });
  it("property: yearly -> family credit never exceeds the charge base and the charge is never negative", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 365 }), fc.bigInt({ min: 1n, max: 500_000n }), (usedDays, paid) => {
        const start = 1_800_000_000_000;
        const end = start + 365 * DAY_MS;
        const c = prorationCredit({ monthlyPriceMinor: paid, periodStartMs: start, periodEndMs: end, nowMs: start + usedDays * DAY_MS });
        expect(c.creditMinor <= paid).toBe(true);
        const u = upgradeCharge(family.priceMinor, c.creditMinor);
        expect(u.chargeMinor >= 0n).toBe(true);
        expect(u.chargeMinor + u.creditAppliedMinor).toBe(family.priceMinor);
      }),
    );
  });
});
