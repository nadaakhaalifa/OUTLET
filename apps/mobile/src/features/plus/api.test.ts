import { describe, expect, it, vi } from "vitest";
import { ApiError, type OutletClient } from "../../services/api-client";
import type { AdapterContext } from "../../services/wire";
import { ApiPlusPort, plusSubscribeOutcomeFromError } from "./api";

type Call = (...a: unknown[]) => Promise<unknown>;
const ok = (data: unknown) => Promise.resolve({ data, etag: null, notModified: false });
const apiError = (status: number, code?: string) =>
  new ApiError("op", status, (code === undefined ? { type: "t", title: "t", status } : { type: "t", title: "t", status, code }) as ConstructorParameters<typeof ApiError>[2], true, null);
const port = (client: Record<string, Call>) =>
  new ApiPlusPort({ client: client as unknown as OutletClient, locale: () => "ar", nowMs: () => 0, deviceId: () => "device-12345" } as AdapterContext);

const plans = [
  { code: "monthly", kind: "individual", interval: "month", price: { amount_minor: "20000" }, trial_days: 14, version: 1 },
  { code: "yearly", kind: "individual", interval: "year", price: { amount_minor: "80000" }, trial_days: 0, version: 1 },
  { code: "family", kind: "family", interval: "year", price: { amount_minor: "120000" }, trial_days: 0, version: 1 },
];
const me = (subscription: unknown, recent: unknown[] = []) => ({ subscription, savings: { total: { amount_minor: "15000" }, recent } });

describe("ApiPlusPort.load", () => {
  it("lists only individual plans and addresses them by code, keeping prices as bigint piastres", async () => {
    const snap = await port({ getPlusPaywall: () => ok({ plans }), getMyPlus: () => ok(me(null)), getMe: () => ok({ age_band: "21_plus" }) }).load();
    expect(snap.plans.map((p) => [p.id, p.interval, p.price])).toEqual([["monthly", "month", 20000n], ["yearly", "year", 80000n]]);
    expect(snap).toMatchObject({ membership: null, minAge: 21, ageEligible: true, salesEnabled: true, trialEligible: true });
  });

  it("a member is not trial eligible, and a plan set without trials is never trial eligible", async () => {
    const sub = { status: "active", plan_code: "monthly", period_end: "2026-11-01T00:00:00Z", trial_end: null, paused_until: null, grace_ends_at: null };
    const member = await port({ getPlusPaywall: () => ok({ plans }), getMyPlus: () => ok(me(sub)), getMe: () => ok({ age_band: "18_20" }) }).load();
    expect(member.trialEligible).toBe(false);
    expect(member.ageEligible).toBe(false);
    expect(member.membership).toEqual({ status: "ACTIVE", planId: "monthly", periodEnd: Date.parse("2026-11-01T00:00:00Z"), trialEnd: null, pausedUntil: null, graceEndsAt: null });
    const noTrial = await port({ getPlusPaywall: () => ok({ plans: [plans[1]] }), getMyPlus: () => ok(me(null)), getMe: () => ok({ age_band: "21_plus" }) }).load();
    expect(noTrial.trialEligible).toBe(false);
  });

  it("an unknown subscription status yields no membership instead of a wrong one", async () => {
    const sub = { status: "weird", plan_code: "monthly", period_end: "2026-11-01T00:00:00Z" };
    const snap = await port({ getPlusPaywall: () => ok({ plans }), getMyPlus: () => ok(me(sub)), getMe: () => ok({ age_band: "21_plus" }) }).load();
    expect(snap.membership).toBeNull();
  });

  it("counts only savings that were not reversed", async () => {
    const snap = await port({
      getPlusPaywall: () => ok({ plans }), getMe: () => ok({ age_band: "21_plus" }),
      getMyPlus: () => ok(me(null, [{ reversed: false }, { reversed: true }, { reversed: false }])),
    }).load();
    expect(snap.savings).toEqual({ total: 15000n, orders: 2 });
  });
});

describe("ApiPlusPort actions", () => {
  it("cancel, pause and switch pass the key and payload", async () => {
    const cancelPlus = vi.fn(() => ok({}));
    const pausePlus = vi.fn(() => ok({}));
    const switchPlusPlan = vi.fn(() => ok({}));
    const p = port({ cancelPlus, pausePlus, switchPlusPlan });
    await p.cancel("k1");
    await p.pause(2, "k2");
    await p.switchPlan("yearly", "k3");
    expect(cancelPlus).toHaveBeenCalledWith(undefined, { idempotencyKey: "k1" });
    expect(pausePlus).toHaveBeenCalledWith({ body: { months: 2 } }, { idempotencyKey: "k2" });
    expect(switchPlusPlan).toHaveBeenCalledWith({ body: { plan_code: "yearly" } }, { idempotencyKey: "k3" });
  });

  it("subscribe is declared unsupported, never a silent success", async () => {
    await expect(port({}).subscribe("monthly", "k")).rejects.toMatchObject({ kind: "failed" });
  });
});

describe("plusSubscribeOutcomeFromError", () => {
  it("maps age and disabled 403s and rethrows everything else", () => {
    expect(plusSubscribeOutcomeFromError(apiError(403, "age_gate"))).toEqual({ kind: "ageGate", minAge: 21 });
    expect(plusSubscribeOutcomeFromError(apiError(403, "plus_sales_disabled"))).toEqual({ kind: "salesDisabled" });
    expect(() => plusSubscribeOutcomeFromError(apiError(403, "other"))).toThrow();
    expect(() => plusSubscribeOutcomeFromError(apiError(403))).toThrow();
    expect(() => plusSubscribeOutcomeFromError(apiError(500, "age_gate"))).toThrow();
    expect(() => plusSubscribeOutcomeFromError(new Error("x"))).toThrow();
  });
});
