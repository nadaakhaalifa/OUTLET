import { describe, expect, it } from "vitest";
import type { ApiResult, StepUpChallenge, VerifiedLogin } from "../../api/port";
import { runQuietVerify } from "../quiet-sign-in/model";
import { runStepUp, UnsupportedPasskeyAssertion, type AssertionResult, type PasskeyAssertionPort, type StepUpDeps } from "./model";

const TOKENS = { accessToken: "a", refreshToken: "r", accessExpiresAtMs: 1 };
const CH: StepUpChallenge = { challengeId: "c", challenge: "x", rpId: "rp", expiresAtMs: 10_000 };
const okLogin: ApiResult<VerifiedLogin> = { ok: true, value: { tokens: TOKENS, isNewAccount: false } };

function setup(assertion: AssertionResult, supported = true, result: ApiResult<VerifiedLogin> = okLogin, now = 0) {
  const calls: string[] = [];
  const passkey: PasskeyAssertionPort = { isSupported: async () => supported, assert: async () => assertion };
  const deps: StepUpDeps = {
    passkey, nowMs: () => now,
    assertPasskey: async () => { calls.push("assert"); return result; },
    save: async () => { calls.push("save"); }, markOnboardingDone: async () => { calls.push("done"); },
  };
  return { deps, calls };
}

describe("step-up (VR-GUEST-06)", () => {
  it("quiet verify surfaces the challenge and stores nothing", async () => {
    const saved: string[] = [];
    const out = await runQuietVerify({
      verifyOtp: async () => ({ ok: false, error: { code: "step_up_required", stepUp: CH } }),
      save: async () => { saved.push("save"); }, markOnboardingDone: async () => { saved.push("done"); },
    }, "+201000000000", "123456");
    expect(out).toEqual({ kind: "step_up", challenge: CH });
    expect(saved).toEqual([]);
  });
  it("step_up_required without a challenge fails closed", async () => {
    const out = await runQuietVerify({ verifyOtp: async () => ({ ok: false, error: { code: "step_up_required" } }), save: async () => undefined, markOnboardingDone: async () => undefined }, "+2010", "123456");
    expect(out).toEqual({ kind: "unavailable" });
  });
  it("a passkey assertion signs in and stores tokens", async () => {
    const { deps, calls } = setup({ kind: "ok", credential: { id: "k" } });
    expect(await runStepUp(deps, CH)).toEqual({ kind: "signed_in" });
    expect(calls).toEqual(["assert", "save", "done"]);
  });
  it("no usable passkey, cancel or unsupported: contact support, nothing stored, no API call", async () => {
    for (const [a, sup] of [[{ kind: "cancelled" }, true], [{ kind: "unsupported" }, true], [{ kind: "ok", credential: {} }, false]] as const) {
      const { deps, calls } = setup(a, sup);
      expect(await runStepUp(deps, CH)).toEqual({ kind: "contact_support" });
      expect(calls).toEqual([]);
    }
  });
  it("an expired challenge is contact support without prompting", async () => {
    const { deps, calls } = setup({ kind: "ok", credential: {} }, true, okLogin, 10_000);
    expect(await runStepUp(deps, CH)).toEqual({ kind: "contact_support" });
    expect(calls).toEqual([]);
  });
  it("a rejected assertion (401) is contact support and stores nothing", async () => {
    const { deps, calls } = setup({ kind: "ok", credential: {} }, true, { ok: false, error: { code: "unauthenticated" } });
    expect(await runStepUp(deps, CH)).toEqual({ kind: "contact_support" });
    expect(calls).toEqual(["assert"]);
  });
  it("a network failure is a retryable error", async () => {
    const { deps } = setup({ kind: "ok", credential: {} }, true, { ok: false, error: { code: "network" } });
    expect(await runStepUp(deps, CH)).toEqual({ kind: "error", errorKey: "errors.offline" });
  });
  it("the default adapter is unsupported", async () => {
    expect(await new UnsupportedPasskeyAssertion().isSupported()).toBe(false);
  });
});
