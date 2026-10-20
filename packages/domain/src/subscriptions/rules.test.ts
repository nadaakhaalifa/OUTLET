import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  entitlementEndsAt,
  entitlementGrants,
  isEntitled,
  meetsMinAge,
  priceChangeNoticeOk,
  selectPlanVersion,
  switchKind,
  trialDenied,
  trialKeys,
  validPauseMonths,
} from "./rules";
import { APP_FEATURE_KEYS, COMMERCE_BENEFIT_KEYS, DAY_MS, type PlusPlan, type PlusSubscription } from "./types";
import { SUBSCRIPTION_STATES } from "../state-machine";

const T0 = 1_800_000_000_000;
const sub = (over: Partial<PlusSubscription>): PlusSubscription => ({
  id: "s",
  userId: "u",
  planId: "p",
  planCode: "plus_monthly",
  planVersion: 1,
  interval: "month",
  status: "ACTIVE",
  periodStartMs: T0,
  periodEndMs: T0 + 30 * DAY_MS,
  trialEndMs: null,
  cancelAtMs: null,
  pausedAtMs: null,
  pausedUntilMs: null,
  graceEndsAtMs: null,
  failedAtMs: null,
  dunningAttempts: 0,
  cycle: 1,
  nextActionAtMs: null,
  pendingPlanCode: null,
  trialReminderSentAtMs: null,
  pspTokenRef: "tok",
  createdAtMs: T0,
  version: 0,
  ...over,
});
const plan = (version: number, effectiveFromMs: number, active = true): PlusPlan => ({
  id: `p${version}`,
  code: "plus_monthly",
  interval: "month",
  priceMinor: 20_000n,
  version,
  active,
  trialDays: 14,
  effectiveFromMs,
  notifiedAtMs: null,
});

describe("entitlement window", () => {
  it("ACTIVE and CANCELLED_AT_PERIOD_END end exactly at period_end", () => {
    for (const status of ["ACTIVE", "CANCELLED_AT_PERIOD_END"] as const) {
      const s = sub({ status });
      expect(isEntitled(s, s.periodEndMs - 1)).toBe(true);
      expect(isEntitled(s, s.periodEndMs)).toBe(false);
    }
  });
  it("TRIALING until trial end, falling back to period end", () => {
    expect(entitlementEndsAt(sub({ status: "TRIALING", trialEndMs: T0 + 5, periodEndMs: T0 + 9 }))).toBe(T0 + 5);
    expect(entitlementEndsAt(sub({ status: "TRIALING", trialEndMs: null, periodEndMs: T0 + 9 }))).toBe(T0 + 9);
  });
  it("PAST_DUE keeps benefits to the grace end, then none", () => {
    const s = sub({ status: "PAST_DUE", graceEndsAtMs: T0 + 7 * DAY_MS, periodEndMs: T0 });
    expect(isEntitled(s, T0 + 7 * DAY_MS - 1)).toBe(true);
    expect(isEntitled(s, T0 + 7 * DAY_MS)).toBe(false);
    expect(isEntitled(sub({ status: "PAST_DUE", graceEndsAtMs: null }), T0)).toBe(false);
  });
  it("PAUSED and EXPIRED never entitle", () => {
    expect(entitlementEndsAt(sub({ status: "PAUSED" }))).toBeNull();
    expect(entitlementEndsAt(sub({ status: "EXPIRED" }))).toBeNull();
    expect(isEntitled(sub({ status: "PAUSED" }), T0)).toBe(false);
  });
  it("property: no state entitles at or after its end instant", () => {
    fc.assert(
      fc.property(fc.constantFrom(...SUBSCRIPTION_STATES), fc.integer({ min: 0, max: 10_000 }), (status, off) => {
        const s = sub({ status, trialEndMs: T0 + 100, graceEndsAtMs: T0 + 200, periodEndMs: T0 + 300 });
        const end = entitlementEndsAt(s);
        const at = (end ?? T0) + off;
        expect(isEntitled(s, at)).toBe(false);
      }),
    );
  });
});

describe("Plan A entitlement groups", () => {
  it("grants only commerce benefits and keeps app_features empty", () => {
    const g = entitlementGrants();
    expect(g).toHaveLength(COMMERCE_BENEFIT_KEYS.length);
    expect(APP_FEATURE_KEYS).toHaveLength(0);
    expect(g.every((x) => x.group === "commerce_benefits")).toBe(true);
    expect(g.map((x) => x.key)).toContain("free_delivery");
  });
});

describe("trial", () => {
  it("builds one key per known identifier", () => {
    expect(trialKeys({ phoneHash: "p", deviceId: "d", cardFingerprint: "c" })).toEqual(["card:c", "phone:p", "device:d"]);
    expect(trialKeys({ phoneHash: null, deviceId: null, cardFingerprint: "c" })).toEqual(["card:c"]);
  });
  it("same card on a new phone and device is denied", () => {
    const claimed = new Set(trialKeys({ phoneHash: "p1", deviceId: "d1", cardFingerprint: "c" }));
    expect(trialDenied(trialKeys({ phoneHash: "p2", deviceId: "d2", cardFingerprint: "c" }), claimed)).toBe(true);
    expect(trialDenied(trialKeys({ phoneHash: "p1", deviceId: "d9", cardFingerprint: "c9" }), claimed)).toBe(true);
    expect(trialDenied(trialKeys({ phoneHash: "p2", deviceId: "d2", cardFingerprint: "c2" }), claimed)).toBe(false);
  });
});

describe("age gate", () => {
  it("unknown age fails closed; 20 fails and 21 passes at min 21", () => {
    expect(meetsMinAge(null, 21)).toBe(false);
    expect(meetsMinAge(20, 21)).toBe(false);
    expect(meetsMinAge(21, 21)).toBe(true);
    expect(meetsMinAge(20, 18)).toBe(true);
  });
});

describe("plan versions and notice", () => {
  it("selects the highest active version already effective", () => {
    const v = [plan(1, 0), plan(2, T0 + 30 * DAY_MS), plan(3, T0, false)];
    expect(selectPlanVersion(v, T0)?.version).toBe(1);
    expect(selectPlanVersion(v, T0 + 30 * DAY_MS)?.version).toBe(2);
    expect(selectPlanVersion([], T0)).toBeNull();
    expect(selectPlanVersion([plan(1, T0 + 1)], T0)).toBeNull();
  });
  it("requires 30 days notice", () => {
    expect(priceChangeNoticeOk(T0, T0 + 30 * DAY_MS)).toBe(true);
    expect(priceChangeNoticeOk(T0, T0 + 30 * DAY_MS - 1)).toBe(false);
  });
  it("pause is 1 to 3 whole months", () => {
    expect([0, 1, 2, 3, 4, 1.5].map(validPauseMonths)).toEqual([false, true, true, true, false, false]);
  });
  it("switch kinds", () => {
    expect(switchKind("month", "year")).toBe("upgrade_now");
    expect(switchKind("year", "month")).toBe("downgrade_at_period_end");
    expect(switchKind("year", "year")).toBe("same");
  });
});
