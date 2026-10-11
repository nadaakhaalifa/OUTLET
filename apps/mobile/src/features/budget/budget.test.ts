import { describe, expect, it } from "vitest";
import { clockFromServer } from "../drops/serverClock";
import {
  FIXTURE_SUMMARY as S, InMemoryBudgetPort, PortError, affordability, availableAfterPayday, capState, effectivePayday, holdSeconds, holdState,
  parseAmountEgp, parsePayday, remainingNow, unlockState, wishlistAffordability, type BudgetSummary,
} from "./model";

const sum = (o: Partial<BudgetSummary>): BudgetSummary => ({ ...S, ...o });

describe("remaining", () => {
  it("is budget minus spent minus installments, bag only when toggled", () => {
    expect(remainingNow(S, false)!.remaining).toBe(118_000n);
    expect(remainingNow(S, true)!.remaining).toBe(28_000n);
  });
  it("clamps the display at zero and exposes the overshoot", () => {
    const r = remainingNow(sum({ spentThisCycle: 600_000n }), false)!;
    expect(r.over).toBe(true);
    expect(r.display).toBe(0n);
    expect(r.overBy).toBe(162_000n);
  });
  it("is null without a budget", () => {
    expect(remainingNow(sum({ settings: null }), false)).toBeNull();
    expect(availableAfterPayday(sum({ settings: null }))).toBeNull();
  });
  it("after payday is the full budget less next-cycle installments, never negative", () => {
    expect(availableAfterPayday(S)).toBe(438_000n);
    expect(availableAfterPayday(sum({ installmentsNextCycle: 9_999_999n }))).toBe(0n);
  });
});

describe("affordability", () => {
  it("splits now / after payday / no", () => {
    expect(affordability(10n, 20n, 50n)).toBe("now");
    expect(affordability(30n, 20n, 50n)).toBe("afterPayday");
    expect(affordability(80n, 20n, 50n)).toBe("no");
    expect(wishlistAffordability(S, false).map((x) => x.status)).toEqual(["now", "afterPayday", "no"]);
  });
});

describe("payday and parsing", () => {
  it("clamps day 31 to the last day of shorter months", () => {
    expect(effectivePayday(31, 2026, 3)).toBe(30);
    expect(effectivePayday(31, 2026, 1)).toBe(28);
    expect(effectivePayday(31, 2028, 1)).toBe(29);
    expect(effectivePayday(25, 2026, 3)).toBe(25);
  });
  it("validates amount and payday including Eastern Arabic digits", () => {
    expect(parseAmountEgp("٥٠٠٠")).toEqual({ ok: true, value: 500_000n });
    expect(parseAmountEgp("0")).toEqual({ ok: false });
    expect(parsePayday("31")).toBe(31);
    expect(parsePayday("32")).toBeNull();
    expect(parsePayday("0")).toBeNull();
  });
});

describe("caps", () => {
  it("only blocks when nothing remains and the mode is not off", () => {
    const over = remainingNow(sum({ spentThisCycle: 600_000n }), false)!;
    expect(capState("off", over).kind).toBe("off");
    expect(capState("soft", over).kind).toBe("softReached");
    expect(capState("hard", over).kind).toBe("hardReached");
    expect(capState("hard", remainingNow(S, false)).kind).toBe("notReached");
  });
  it("soft hold lasts exactly ten seconds", () => {
    expect(holdState(null, 5)).toBeNull();
    const mid = holdState(1000, 4500)!;
    expect(mid.done).toBe(false);
    expect(holdSeconds(mid)).toBe(7);
    expect(holdState(1000, 11_000)!.done).toBe(true);
    expect(holdState(1000, 99_000)!.remainingMs).toBe(0);
  });
  it("hard unlock follows server time, not a skewed device clock", () => {
    const clock = clockFromServer(1_000_000, 500_000); // device is 500 s behind
    expect(unlockState(null, clock, 0).kind).toBe("none");
    expect(unlockState(1_100_000, clock, 550_000).kind).toBe("pending");
    expect(unlockState(1_100_000, clock, 600_000).kind).toBe("ready");
  });
});

describe("consent gate and port", () => {
  it("refuses summary before consent and wipes derived data on withdrawal", async () => {
    const p = new InMemoryBudgetPort();
    expect(await p.consent()).toBe(false);
    await expect(p.summary()).rejects.toBeInstanceOf(PortError);
    await p.setConsent(true);
    expect((await p.summary()).settings).not.toBeNull();
    await p.setConsent(false);
    await p.setConsent(true);
    expect((await p.summary()).settings).toBeNull();
  });
  it("hard unlock request returns a delay of 24 hours from server time", async () => {
    const p = new InMemoryBudgetPort(S, true);
    const r = await p.requestUnlock();
    expect(r.unlockAtMs - S.serverNowMs).toBe(24 * 3_600_000);
  });
});
