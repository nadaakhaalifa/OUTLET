import { beforeEach, describe, expect, it } from "vitest";
import { resources } from "@outlet/i18n";
import { noteText } from "../guest";
import { CHECKOUT_STEP_ONE, peekReturnTarget, setReturnTarget, takeReturnTarget } from "../flow";
import { openCheckoutGate, SIGN_UP_ROUTE } from "./model";
const en = resources.en;
const ar = resources.ar;

const run = (session: boolean, done: boolean) => {
  const pushed: string[] = [];
  const p = openCheckoutGate({ hasSession: async () => session, isOnboardingDone: async () => done, push: (h) => { pushed.push(h); } });
  return { p, pushed };
};

describe("openCheckoutGate", () => {
  beforeEach(() => setReturnTarget(null));

  it("opens the gate for a guest and remembers checkout step 1 as the return target", async () => {
    const { p, pushed } = run(false, false);
    expect(await p).toBe("gate");
    expect(pushed).toEqual([SIGN_UP_ROUTE]);
    expect(peekReturnTarget()).toBe(CHECKOUT_STEP_ONE);
  });
  it("signed-in shoppers skip the gate", async () => {
    const { p, pushed } = run(true, true);
    expect(await p).toBe("checkout");
    expect(pushed).toEqual([CHECKOUT_STEP_ONE]);
    expect(peekReturnTarget()).toBeNull();
  });
  it("a session without a finished sign-up resumes inside the gate", async () => {
    const { p, pushed } = run(true, false);
    expect(await p).toBe("gate");
    expect(pushed).toEqual([SIGN_UP_ROUTE]);
  });
  it("the return target is read once", () => {
    setReturnTarget(CHECKOUT_STEP_ONE);
    expect(takeReturnTarget()).toBe(CHECKOUT_STEP_ONE);
    expect(takeReturnTarget()).toBeNull();
  });
});

describe("copy", () => {
  it("every merge note maps to a key that exists in both languages, with the same placeholders", () => {
    const notes = [
      { kind: "kept_larger", reason: null }, { kind: "moved_to_saved", reason: "over_cap" }, { kind: "moved_to_saved", reason: "unavailable" },
      { kind: "unavailable", reason: null }, { kind: "store_suspended", reason: null }, { kind: "clamped", reason: null },
    ] as const;
    const get = (o: unknown, path: string): string => path.split(".").reduce<unknown>((x, k) => (x as Record<string, unknown>)[k], o) as string;
    for (const x of notes) {
      const { key } = noteText({ kind: x.kind, title: "T", localQty: 2, accountQty: 3, qty: 3, reason: x.reason });
      const e = get(en, key); const a = get(ar, key);
      expect(typeof e).toBe("string"); expect(typeof a).toBe("string");
      expect([...e.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()).toEqual([...a.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort());
    }
  });
  it("uses no legacy brand name in the new namespaces", () => {
    expect(JSON.stringify(ar.checkoutGate) + JSON.stringify(ar.guestMerge)).not.toContain("أوتلت");
  });
});

import { gateAccessAllowed, resolveGateAccess } from "./access";
import { flushAfterSignUp } from "./model";

describe("useGateGuard rule (direct open of /sign-up and /onboarding/account)", () => {
  beforeEach(() => setReturnTarget(null));
  const deps = (session: boolean, done: boolean, otp = false) => ({ hasSession: async () => session, isOnboardingDone: async () => done, otpInProgress: () => otp });

  it("denies a guest who did not tap Checkout", async () => {
    expect(await resolveGateAccess(deps(false, false))).toBe(false);
  });
  it("allows a guest while the gate is open (return target set)", async () => {
    setReturnTarget(CHECKOUT_STEP_ONE);
    expect(await resolveGateAccess(deps(false, false))).toBe(true);
  });
  it("lets an interrupted sign-up resume (session, onboarding unfinished), and an OTP in flight", async () => {
    expect(await resolveGateAccess(deps(true, false))).toBe(true);
    expect(await resolveGateAccess(deps(false, false, true))).toBe(true);
  });
  it("denies a fully onboarded account", async () => {
    expect(await resolveGateAccess(deps(true, true))).toBe(false);
  });
  it("pure rule", () => {
    expect(gateAccessAllowed({ returnTarget: null, hasSession: false, onboardingDone: false, otpInProgress: false })).toBe(false);
  });
});

describe("flushAfterSignUp", () => {
  it("flushes the funnel and consents once, and swallows failures", async () => {
    let f = 0; let c = 0; const logged: string[] = [];
    await flushAfterSignUp({ role: { flushFunnel: () => { f++; } }, consent: { flushPending: async () => { c++; } } });
    expect([f, c]).toEqual([1, 1]);
    await flushAfterSignUp({ role: { flushFunnel: () => { throw new TypeError("x"); } }, consent: { flushPending: async () => { throw new Error("down"); } } }, (n) => logged.push(n));
    expect(logged).toEqual(["TypeError", "Error"]);
    await expect(flushAfterSignUp({ role: {}, consent: { flushPending: async () => undefined } })).resolves.toBeUndefined();
  });
});

describe("gate access: finished members and sign-in mode", () => {
  it("denies a fully onboarded member even with an in-flight marker or a return target", () => {
    expect(gateAccessAllowed({ returnTarget: null, hasSession: true, onboardingDone: true, otpInProgress: true })).toBe(false);
    expect(gateAccessAllowed({ returnTarget: "/checkout", hasSession: true, onboardingDone: true, otpInProgress: true })).toBe(false);
  });
  it("an interrupted sign-up (session, onboarding not done) still resumes", () => {
    expect(gateAccessAllowed({ returnTarget: null, hasSession: true, onboardingDone: false, otpInProgress: false })).toBe(true);
  });
  it("sign-in only mode is a flag the OTP step reads, cleared on finish", async () => {
    const { isSignInOnly, setSignInOnly } = await import("../flow");
    setSignInOnly(true);
    expect(isSignInOnly()).toBe(true);
    setSignInOnly(false);
    expect(isSignInOnly()).toBe(false);
  });
});

describe("merge phase stays reachable right after sign-up", () => {
  it("a finished account with a return target may open the merge phase only", () => {
    const f = { returnTarget: "/checkout", hasSession: true, onboardingDone: true, otpInProgress: false };
    expect(gateAccessAllowed({ ...f, mergePhase: true })).toBe(true);
    expect(gateAccessAllowed(f)).toBe(false);
    expect(gateAccessAllowed({ ...f, returnTarget: null, mergePhase: true })).toBe(false);
  });
});

describe("merge phase needs a session, and merge logic", () => {
  it("phase=merge with a return target but no session is denied", () => {
    const f = { returnTarget: "/checkout", hasSession: false, onboardingDone: false, otpInProgress: true };
    expect(gateAccessAllowed({ ...f, mergePhase: true })).toBe(false);
    expect(gateAccessAllowed(f)).toBe(true);
  });
  it("flushes consents only for new accounts; 401 offers no continue-without", async () => {
    const { shouldFlushConsents, offersContinueWithout } = await import("./merge-phase-logic");
    expect(shouldFlushConsents(true)).toBe(true);
    expect(shouldFlushConsents(false)).toBe(false);
    expect(offersContinueWithout(401)).toBe(false);
    expect(offersContinueWithout(500)).toBe(true);
    expect(offersContinueWithout(0)).toBe(true);
  });
  it("new-account flag defaults false", async () => {
    const { isNewAccountSignUp, setNewAccountSignUp } = await import("../flow");
    expect(isNewAccountSignUp()).toBe(false);
    setNewAccountSignUp(true);
    expect(isNewAccountSignUp()).toBe(true);
    setNewAccountSignUp(false);
  });
});
