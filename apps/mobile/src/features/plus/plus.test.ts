import { describe, expect, it } from "vitest";
import { resources } from "../../../../../packages/i18n/src/index";
import { formatMoney } from "../money-display";
import {
  CANCEL_TAPS_FROM_ME, FIXTURE_PLUS, InMemoryPlusPort, buildPlus, defaultPlanId, firstChargeAt, formatCairoDate, plusFailureState, yearlyPitch,
  type Membership, type PlusPlan, type PlusSnapshot,
} from "./model";

const DAY = 86_400_000;
const month: PlusPlan = { id: "m", interval: "month", price: 20_000n, trialDays: 14, version: 1 };
const year: PlusPlan = { id: "y", interval: "year", price: 80_000n, trialDays: 14, version: 1 };
const member = (o: Partial<Membership>): Membership => ({
  status: "ACTIVE", planId: "m", periodEnd: 10 * DAY, trialEnd: null, pausedUntil: null, graceEndsAt: null, ...o,
});
const snap = (o: Partial<PlusSnapshot> = {}): PlusSnapshot => ({ ...FIXTURE_PLUS, plans: [month, year], ...o });

describe("yearly pitch from server prices", () => {
  it("800 = 4 x 200: pay 4, get 8 free, saving 1,600 EGP (67%)", () => {
    const p = yearlyPitch([month, year]);
    expect(p).toEqual({ payMonths: 4, freeMonths: 8, saving: 160_000n, savingPct: 66 });
  });
  it("follows the server price, never a constant", () => {
    const p = yearlyPitch([month, { ...year, price: 100_000n }]);
    expect(p?.payMonths).toBe(5);
    expect(p?.freeMonths).toBe(7);
  });
  it("shows no pitch when the yearly price is not a whole number of months or is not cheaper", () => {
    expect(yearlyPitch([month, { ...year, price: 85_000n }])).toBeNull();
    expect(yearlyPitch([month, { ...year, price: 240_000n }])).toBeNull();
    expect(yearlyPitch([year])).toBeNull();
  });
  it("selects yearly by default", () => {
    expect(defaultPlanId([month, year])).toBe("y");
    expect(defaultPlanId([month])).toBe("m");
    const v = buildPlus(snap({ plans: [month, year] }));
    expect(v.options.map((o) => o.plan.id)).toEqual(["m", "y"]);
    expect(v.options.find((o) => o.plan.id === "y")?.pitch?.payMonths).toBe(4);
  });
});

describe("paywall gates", () => {
  it("blocks purchase under the age rule, with the server minimum age", () => {
    const v = buildPlus(snap({ ageEligible: false, minAge: 21 }));
    expect(v.purchaseBlocker).toBe("ageGate");
    expect(v.minAge).toBe(21);
  });
  it("blocks new sales behind the kill switch, and with no plans", () => {
    expect(buildPlus(snap({ salesEnabled: false })).purchaseBlocker).toBe("salesDisabled");
    expect(buildPlus(snap({ plans: [] })).purchaseBlocker).toBe("noPlans");
    expect(buildPlus(snap()).purchaseBlocker).toBeNull();
  });
  it("shows the trial only to eligible non-members", () => {
    expect(buildPlus(snap()).showTrial).toBe(true);
    expect(buildPlus(snap({ trialEligible: false })).showTrial).toBe(false);
    expect(buildPlus(snap({ plans: [{ ...month, trialDays: 0 }] })).showTrial).toBe(false);
  });
  it("computes the first charge date from the trial length", () => {
    expect(firstChargeAt(month, true, 1_000)).toBe(1_000 + 14 * DAY);
    expect(firstChargeAt(month, false, 1_000)).toBe(1_000);
  });
  it("formats Cairo dates in the locale", () => {
    expect(formatCairoDate(Date.UTC(2026, 0, 31, 23, 0), "en")).toContain("February");
  });
});

describe("management", () => {
  it("cancel is on the first manage view, one tap, no confirmation: 2 taps from Me", () => {
    expect(CANCEL_TAPS_FROM_ME).toBe(2);
    for (const status of ["ACTIVE", "TRIALING", "PAST_DUE"] as const) {
      const v = buildPlus(snap({ membership: member({ status, trialEnd: 5 * DAY, graceEndsAt: 7 * DAY }) }));
      const cancel = v.member?.actions.find((a) => a.action === "cancel");
      expect(cancel?.requiresConfirmation).toBe(false);
    }
  });
  it("offers pause alongside cancel, and the yearly switch only from monthly", () => {
    const a = buildPlus(snap({ membership: member({}) })).member;
    expect(a?.actions.map((x) => x.action)).toEqual(["pause", "switchPlan", "cancel"]);
    expect(a?.switchTarget?.id).toBe("y");
    const y = buildPlus(snap({ membership: member({ planId: "y" }) })).member;
    expect(y?.actions.map((x) => x.action)).toEqual(["pause", "cancel"]);
  });
  it("cancelled members keep benefits to period end and get no actions", () => {
    const m = buildPlus(snap({ membership: member({ status: "CANCELLED_AT_PERIOD_END", periodEnd: 9 * DAY }) })).member;
    expect(m?.benefitsEndAt).toBe(9 * DAY);
    expect(m?.actions).toEqual([]);
  });
  it("reminds 2 days before the first charge during a trial", () => {
    const m = buildPlus(snap({ membership: member({ status: "TRIALING", trialEnd: 14 * DAY }) })).member;
    expect(m?.trialReminderAt).toBe(12 * DAY);
    expect(m?.firstChargeAt).toBe(14 * DAY);
  });
  it("past due keeps benefits until grace end", () => {
    const m = buildPlus(snap({ membership: member({ status: "PAST_DUE", graceEndsAt: 8 * DAY }) })).member;
    expect(m?.benefitsEndAt).toBe(8 * DAY);
    expect(m?.benefitsActive).toBe(true);
  });
  it("an expired membership returns to the paywall", () => {
    expect(buildPlus(snap({ membership: member({ status: "EXPIRED" }) })).mode).toBe("paywall");
  });
});

describe("savings meter", () => {
  it("comes from the server ledger and is honest when empty", () => {
    expect(buildPlus(snap()).savings.hasSavings).toBe(false);
    const v = buildPlus(snap({ savings: { total: 12_345n, orders: 3 } }));
    expect(v.savings).toEqual({ total: 12_345n, orders: 3, hasSavings: true });
    expect(formatMoney(v.savings.total, "en", "EGP")).toBe("123.45 EGP");
  });
});

describe("fake port", () => {
  it("replays the same outcome for the same idempotency key", async () => {
    const port = new InMemoryPlusPort(FIXTURE_PLUS, null, () => 0);
    await port.subscribe("plan-y", "k1");
    const first = (await port.load()).membership;
    await port.subscribe("plan-y", "k1");
    expect((await port.load()).membership).toEqual(first);
    expect(first?.status).toBe("TRIALING");
  });
  it("reports age gate and kill switch outcomes without charging", async () => {
    expect(await new InMemoryPlusPort(snap({ ageEligible: false })).subscribe("y", "a")).toEqual({ kind: "ageGate", minAge: 21 });
    expect(await new InMemoryPlusPort(snap({ salesEnabled: false })).subscribe("y", "b")).toEqual({ kind: "salesDisabled" });
  });
  it("cancel keeps the membership until period end", async () => {
    const port = new InMemoryPlusPort(snap({ membership: member({}) }));
    await port.cancel();
    expect((await port.load()).membership?.status).toBe("CANCELLED_AT_PERIOD_END");
  });
  it("maps failures to loading states", async () => {
    const port = new InMemoryPlusPort(FIXTURE_PLUS, "offline");
    await expect(port.load()).rejects.toMatchObject({ kind: "offline" });
    expect(plusFailureState(await port.load().catch((e: unknown) => e))).toEqual({ status: "error", offline: true });
    expect(plusFailureState(new Error("x"))).toEqual({ status: "error", offline: false });
  });
});

function leaves(o: unknown, path = ""): [string, string][] {
  if (typeof o === "string") return [[path, o]];
  if (o !== null && typeof o === "object") return Object.entries(o).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));
  return [];
}

describe("Plus copy lint", () => {
  const SHAMING = [
    /are you sure/i, /you will lose/i, /you.ll lose/i, /miss out/i, /don.t leave/i, /no thanks, i/i, /i don.t want/i, /give up/i,
    /هل أنت متأكد/, /ستخسر/, /ستفقد/, /لا أريد/,
  ];
  for (const lang of ["en", "ar"] as const) {
    const strings = leaves(resources[lang].plus);
    it(`${lang}: no confirm-shaming`, () => {
      for (const [k, s] of strings) for (const re of SHAMING) expect(re.test(s), `${k}: ${s}`).toBe(false);
    });
    it(`${lang}: no hard-coded numbers or prices (all come from the server)`, () => {
      for (const [k, s] of strings) expect(/[0-9٠-٩]/.test(s.replace(/\{\{[^}]+\}\}/g, "")), `${k}: ${s}`).toBe(false);
    });
  }
  it("states the auto-renew and the cancel path in the disclosure", () => {
    expect(resources.en.plus.disclosure.renews).toMatch(/automatically/);
    expect(resources.en.plus.disclosure.cancel).toMatch(/cancel/i);
  });
});
