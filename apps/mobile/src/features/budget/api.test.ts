import { describe, expect, it, vi } from "vitest";
import { ApiError, type OutletClient } from "../../services/api-client";
import type { AdapterContext } from "../../services/wire";
import { ApiBudgetPort, isConsentRequired } from "./api";

type Call = (...a: unknown[]) => Promise<unknown>;
const ok = (data: unknown) => Promise.resolve({ data, etag: null, notModified: false });
const apiError = (status: number, code?: string) =>
  new ApiError("op", status, (code === undefined ? { type: "t", title: "t", status } : { type: "t", title: "t", status, code }) as ConstructorParameters<typeof ApiError>[2], true, null);
const port = (client: Record<string, Call>) =>
  new ApiBudgetPort({ client: client as unknown as OutletClient, locale: () => "ar", nowMs: () => 1234, deviceId: () => "device-12345" } as AdapterContext);
const m = (amount: string) => ({ amount, currency: "EGP" });

describe("ApiBudgetPort consent", () => {
  it("is granted only for a granted budget_insights purpose", async () => {
    const consents = (list: unknown[]) => ({ getConsents: () => ok({ consents: list }) });
    expect(await port(consents([{ purpose: "budget_insights", granted: true }])).consent()).toBe(true);
    expect(await port(consents([{ purpose: "budget_insights", granted: false }])).consent()).toBe(false);
    expect(await port(consents([{ purpose: "analytics", granted: true }])).consent()).toBe(false);
  });

  it("setConsent echoes the current policy version, defaulting to 1", async () => {
    const updateConsents = vi.fn(() => ok({}));
    await port({ getConsents: () => ok({ consents: [{ purpose: "budget_insights", granted: false, policy_version: "7" }] }), updateConsents }).setConsent(true);
    expect(updateConsents).toHaveBeenCalledWith({ body: { changes: [{ purpose: "budget_insights", granted: true, policy_version: "7" }] } });
    const second = vi.fn(() => ok({}));
    await port({ getConsents: () => ok({ consents: [] }), updateConsents: second }).setConsent(false);
    expect(second).toHaveBeenCalledWith({ body: { changes: [{ purpose: "budget_insights", granted: false, policy_version: "1" }] } });
  });
});

describe("ApiBudgetPort.summary", () => {
  it("maps an active budget with installments and an unlock time", async () => {
    const s = await port({
      getMyBudgetSummary: () => ok({
        state: "active", budget: m("500000"), payday: 25, spent: m("120000"), bag: m("30000"),
        cap: { mode: "hard", unlock_at: "2026-10-02T00:00:00Z" },
        installments: { total: m("62000"), items: [{ provider: "valu", monthly: m("62000"), source: "provider" }] },
      }),
    }).summary();
    expect(s.settings).toEqual({ amount: 500000n, payday: 25, capMode: "hard" });
    expect(s).toMatchObject({ spentThisCycle: 120000n, bagTotal: 30000n, installmentsDueThisCycle: 62000n, installmentsNextCycle: 0n, serverNowMs: 1234, wishlist: [] });
    expect(s.installments).toEqual([{ id: "valu:0", provider: "valu", monthly: 62000n, source: "provider" }]);
    expect(s.unlockAtMs).toBe(Date.parse("2026-10-02T00:00:00Z"));
  });

  it("falls back to zeros and no settings when nothing is configured", async () => {
    const s = await port({ getMyBudgetSummary: () => ok({ state: "unset" }) }).summary();
    expect(s.settings).toBeNull();
    expect(s).toMatchObject({ spentThisCycle: 0n, bagTotal: 0n, installmentsDueThisCycle: 0n, unlockAtMs: null, installments: [] });
  });

  it("an active state without a payday has no settings, and an explicit null bag is zero", async () => {
    const s = await port({ getMyBudgetSummary: () => ok({ state: "active", budget: m("1"), bag: null }) }).summary();
    expect(s.settings).toBeNull();
    expect(s.bagTotal).toBe(0n);
  });

  it("an active budget without a cap defaults the cap mode to off", async () => {
    const s = await port({ getMyBudgetSummary: () => ok({ state: "active", budget: m("100"), payday: 1 }) }).summary();
    expect(s.settings?.capMode).toBe("off");
  });
});

describe("ApiBudgetPort writes", () => {
  it("saveSettings sends piastres as a decimal string with the idempotency key", async () => {
    const putMyBudget = vi.fn(() => ok({}));
    await port({ putMyBudget }).saveSettings({ amount: 250000n, payday: 28, capMode: "soft" }, "k1");
    expect(putMyBudget).toHaveBeenCalledWith({ body: { amount: { amount: "250000", currency: "EGP" }, payday: 28, cap_mode: "soft" } }, { idempotencyKey: "k1" });
  });

  it("requestUnlock parses the unlock instant", async () => {
    const r = await port({ requestBudgetCapUnlock: () => ok({ unlock_at: "2026-10-03T12:00:00Z" }) }).requestUnlock("k2");
    expect(r.unlockAtMs).toBe(Date.parse("2026-10-03T12:00:00Z"));
  });

  it("failures surface as PortError", async () => {
    await expect(port({ putMyBudget: () => Promise.reject(apiError(500)) }).saveSettings({ amount: 1n, payday: 1, capMode: "off" }, "k")).rejects.toMatchObject({ kind: "failed" });
  });
});

describe("isConsentRequired", () => {
  it("is true only for a 403 consent_required problem", () => {
    expect(isConsentRequired(apiError(403, "consent_required"))).toBe(true);
    expect(isConsentRequired(apiError(403, "other"))).toBe(false);
    expect(isConsentRequired(apiError(401, "consent_required"))).toBe(false);
    expect(isConsentRequired(new Error("x"))).toBe(false);
  });
});
