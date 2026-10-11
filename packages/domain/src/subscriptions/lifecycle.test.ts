import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { InvalidTransitionError, SUBSCRIPTION_STATES, subscriptionMachine } from "../state-machine";
import {
  cancel,
  cancelWithRefund,
  convertTrial,
  dunningFailed,
  dunningSucceeded,
  expireUnpaidTrial,
  graceElapsed,
  pause,
  periodEnded,
  reactivate,
  renewFailed,
  renewSucceeded,
  resume,
  scheduleSwitch,
  startPaid,
  startTrial,
  switchNow,
  trialReminderSent,
} from "./lifecycle";
import { isEntitled } from "./rules";
import { DAY_MS, type PlusPlan, type PlusSubscription } from "./types";

const T0 = Date.UTC(2026, 5, 1);
const monthly: PlusPlan = { id: "pm", code: "plus_monthly", interval: "month", priceMinor: 20_000n, version: 1, active: true, trialDays: 14, effectiveFromMs: 0, notifiedAtMs: null };
const yearly: PlusPlan = { ...monthly, id: "py", code: "plus_yearly", interval: "year", priceMinor: 80_000n };
const n = { id: "s1", userId: "u1", plan: monthly, pspTokenRef: "tok", nowMs: T0 };

describe("start", () => {
  it("trial: entitled for 14 days, reminder 2 days before the charge", () => {
    const s = startTrial(n);
    expect(s.status).toBe("TRIALING");
    expect(s.trialEndMs).toBe(T0 + 14 * DAY_MS);
    expect(s.nextActionAtMs).toBe(T0 + 12 * DAY_MS);
    expect(isEntitled(s, T0 + 14 * DAY_MS - 1)).toBe(true);
    expect(isEntitled(s, T0 + 14 * DAY_MS)).toBe(false);
    const r = trialReminderSent(s, T0 + 12 * DAY_MS);
    expect(r.nextActionAtMs).toBe(T0 + 14 * DAY_MS);
    expect(r.trialReminderSentAtMs).toBe(T0 + 12 * DAY_MS);
  });
  it("a trial shorter than the reminder lead goes straight to the end", () => {
    const s = startTrial({ ...n, plan: { ...monthly, trialDays: 1 } });
    expect(s.nextActionAtMs).toBe(T0 + DAY_MS);
  });
  it("a plan without a trial cannot start one", () => {
    expect(() => startTrial({ ...n, plan: { ...monthly, trialDays: 0 } })).toThrow();
  });
  it("paid start is ACTIVE for one period, cycle 1", () => {
    const s = startPaid(n);
    expect(s.status).toBe("ACTIVE");
    expect(s.cycle).toBe(1);
    expect(s.periodEndMs).toBe(Date.UTC(2026, 6, 1));
    expect(s.nextActionAtMs).toBe(s.periodEndMs);
  });
  it("trial converts to ACTIVE on payment or expires unpaid", () => {
    const t = startTrial(n);
    expect(convertTrial(t, t.trialEndMs ?? 0, yearly).periodEndMs).toBe(Date.UTC(2027, 5, 15));
    const e = expireUnpaidTrial(t);
    expect(e.status).toBe("EXPIRED");
    expect(e.nextActionAtMs).toBeNull();
  });
});

describe("renewal and dunning", () => {
  it("renewal chains periods and clears a scheduled switch", () => {
    const s = { ...startPaid(n), pendingPlanCode: "plus_monthly" };
    const r = renewSucceeded(s, s.periodEndMs, monthly);
    expect(r.cycle).toBe(2);
    expect(r.periodStartMs).toBe(s.periodEndMs);
    expect(r.pendingPlanCode).toBeNull();
    expect(renewSucceeded(s, s.periodEndMs + 5 * DAY_MS, monthly).periodStartMs).toBe(s.periodEndMs + 5 * DAY_MS);
    expect(() => renewSucceeded(cancel(s, T0), T0, monthly)).toThrow();
  });
  it("failed renewal: PAST_DUE with 7 day grace, benefits continue, entitlements revoke at grace end", () => {
    const s = startPaid(n);
    const failAt = s.periodEndMs;
    const p = renewFailed(s, failAt);
    expect(p.status).toBe("PAST_DUE");
    expect(p.cycle).toBe(2);
    expect(p.graceEndsAtMs).toBe(failAt + 7 * DAY_MS);
    expect(p.nextActionAtMs).toBe(failAt + DAY_MS);
    expect(isEntitled(p, failAt + 7 * DAY_MS - 1)).toBe(true);
    expect(isEntitled(p, failAt + 7 * DAY_MS)).toBe(false);
    const a1 = dunningFailed(p, 1, failAt + DAY_MS);
    expect(a1.nextActionAtMs).toBe(failAt + 3 * DAY_MS);
    const a2 = dunningFailed(a1, 2, failAt + 3 * DAY_MS);
    expect(a2.nextActionAtMs).toBe(failAt + 7 * DAY_MS);
    const a3 = dunningFailed(a2, 3, failAt + 7 * DAY_MS);
    expect(a3.nextActionAtMs).toBe(failAt + 7 * DAY_MS);
    const ex = graceElapsed(a3);
    expect(ex.status).toBe("EXPIRED");
    expect(() => dunningFailed(s, 1, failAt)).toThrow();
  });
  it("dunning failure past the grace schedules the expiry now", () => {
    const p = renewFailed(startPaid(n), T0);
    expect(dunningFailed(p, 1, T0 + 9 * DAY_MS).nextActionAtMs).toBe(T0 + 9 * DAY_MS);
  });
  it("recovery returns to ACTIVE with a fresh period and clears dunning state", () => {
    const p = dunningFailed(renewFailed(startPaid(n), T0 + 30 * DAY_MS), 1, T0 + 31 * DAY_MS);
    const r = dunningSucceeded(p, T0 + 32 * DAY_MS, monthly);
    expect(r.status).toBe("ACTIVE");
    expect(r.failedAtMs).toBeNull();
    expect(r.graceEndsAtMs).toBeNull();
    expect(r.dunningAttempts).toBe(0);
    expect(r.periodStartMs).toBe(T0 + 32 * DAY_MS);
  });
});

describe("cancel, pause, switch", () => {
  const active = startPaid(n);
  it("cancel keeps benefits until period_end exactly, then EXPIRED", () => {
    const c = cancel(active, T0 + DAY_MS);
    expect(c.status).toBe("CANCELLED_AT_PERIOD_END");
    expect(c.cancelAtMs).toBe(active.periodEndMs);
    expect(isEntitled(c, active.periodEndMs - 1)).toBe(true);
    expect(isEntitled(c, active.periodEndMs)).toBe(false);
    expect(periodEnded(c).status).toBe("EXPIRED");
  });
  it("cancelling during trial or dunning is paid through the boundary", () => {
    const t = cancel(startTrial(n), T0);
    expect(t.cancelAtMs).toBe(T0 + 14 * DAY_MS);
    const p = renewFailed(active, active.periodEndMs);
    const c = cancel(p, active.periodEndMs + DAY_MS);
    expect(c.cancelAtMs).toBe(active.periodEndMs + 7 * DAY_MS);
    expect(c.graceEndsAtMs).toBeNull();
  });
  it("reactivate before the end, refused after", () => {
    const c = cancel(active, T0);
    expect(reactivate(c, T0 + DAY_MS).status).toBe("ACTIVE");
    expect(reactivate(c, T0 + DAY_MS).cancelAtMs).toBeNull();
    expect(() => reactivate(c, c.periodEndMs)).toThrow();
  });
  it("pause stops entitlements and resume shifts the paid period by the paused time", () => {
    const p = pause(active, T0 + 10 * DAY_MS, 1);
    expect(p.status).toBe("PAUSED");
    expect(isEntitled(p, T0 + 11 * DAY_MS)).toBe(false);
    expect(p.pausedUntilMs).toBe(Date.UTC(2026, 6, 11));
    const r = resume(p, T0 + 20 * DAY_MS);
    expect(r.status).toBe("ACTIVE");
    expect(r.periodEndMs).toBe(active.periodEndMs + 10 * DAY_MS);
    expect(r.periodStartMs).toBe(active.periodStartMs + 10 * DAY_MS);
    expect(r.pausedAtMs).toBeNull();
    expect(r.nextActionAtMs).toBe(r.periodEndMs);
  });
  it("cancel while paused resumes then cancels in one step", () => {
    const p = pause(active, T0 + 10 * DAY_MS, 2);
    const c = cancel(p, T0 + 15 * DAY_MS);
    expect(c.status).toBe("CANCELLED_AT_PERIOD_END");
    expect(c.cancelAtMs).toBe(active.periodEndMs + 5 * DAY_MS);
  });
  it("only ACTIVE can pause or switch", () => {
    expect(() => pause(startTrial(n), T0, 1)).toThrow(InvalidTransitionError);
    expect(() => switchNow(startTrial(n), T0, yearly)).toThrow();
    expect(() => scheduleSwitch(startTrial(n), "plus_monthly")).toThrow();
  });
  it("upgrade now starts a yearly period; downgrade is only scheduled", () => {
    const u = switchNow(active, T0 + 10 * DAY_MS, yearly);
    expect(u.planCode).toBe("plus_yearly");
    expect(u.interval).toBe("year");
    expect(u.cycle).toBe(2);
    expect(u.periodEndMs).toBe(Date.UTC(2027, 5, 11));
    const d = scheduleSwitch({ ...u }, "plus_monthly");
    expect(d.pendingPlanCode).toBe("plus_monthly");
    expect(d.planCode).toBe("plus_yearly");
    expect(d.periodEndMs).toBe(u.periodEndMs);
  });
  it("refund inside the window ends it at once; not available in other states", () => {
    expect(cancelWithRefund(active).status).toBe("EXPIRED");
    expect(() => cancelWithRefund(startTrial(n))).toThrow(InvalidTransitionError);
  });
});

describe("property: the lifecycle only ever uses the shared machine", () => {
  type Op = "cancel" | "reactivate" | "pause" | "resume" | "renew" | "fail" | "retry" | "grace" | "end" | "refund";
  const ops: Op[] = ["cancel", "reactivate", "pause", "resume", "renew", "fail", "retry", "grace", "end", "refund"];
  const apply = (s: PlusSubscription, op: Op, now: number): PlusSubscription => {
    switch (op) {
      case "cancel": return cancel(s, now);
      case "reactivate": return reactivate(s, now);
      case "pause": return pause(s, now, 1);
      case "resume": return resume(s, now);
      case "renew": return renewSucceeded(s, now, monthly);
      case "fail": return renewFailed(s, now);
      case "retry": return dunningSucceeded(s, now, monthly);
      case "grace": return graceElapsed(s);
      case "end": return periodEnded(s);
      case "refund": return cancelWithRefund(s);
    }
  };
  it("never reaches an unknown state, EXPIRED is terminal, and no entitlement outlives its end", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.constantFrom(...ops), fc.integer({ min: 0, max: 40 })), { maxLength: 25 }), (steps) => {
        let s = startPaid(n);
        let now = T0;
        for (const [op, days] of steps) {
          now += days * DAY_MS;
          try {
            s = apply(s, op, now);
          } catch {
            continue;
          }
          expect(SUBSCRIPTION_STATES).toContain(s.status);
          if (subscriptionMachine.isTerminal(s.status)) {
            expect(s.nextActionAtMs).toBeNull();
            expect(isEntitled(s, now)).toBe(false);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
