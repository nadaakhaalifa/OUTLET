import { describe, expect, it } from "vitest";
import {
  FLAG_REGISTRY,
  FlagClient,
  InMemoryFlagProvider,
  isKnownFlag,
  KILL_SWITCHES,
  PAYMENT_METHODS,
  paymentKillSwitch,
  RELEASE_FLAGS,
  type EvaluationContext,
  type FlagDecision,
  type FlagProvider,
  type ResolutionDetails,
} from "./index";

describe("registry content", () => {
  it("lists payment methods and switch names exactly", () => {
    expect([...PAYMENT_METHODS]).toEqual(["card", "apple_pay", "mobile_wallet", "instapay", "fawry"]);
    expect(PAYMENT_METHODS.map(paymentKillSwitch)).toEqual([
      "kill.payment.card",
      "kill.payment.apple_pay",
      "kill.payment.mobile_wallet",
      "kill.payment.instapay",
      "kill.payment.fawry",
    ]);
  });
  it("kill switches and release flags carry their documented descriptions", () => {
    expect(KILL_SWITCHES).toStrictEqual({
      "kill.payment.card": { description: "Card payments via the PSP" },
      "kill.payment.apple_pay": { description: "Apple Pay" },
      "kill.payment.mobile_wallet": { description: "Mobile wallet payments (e.g. Vodafone Cash)" },
      "kill.payment.instapay": { description: "InstaPay QR / request-to-pay" },
      "kill.payment.fawry": { description: "Fawry reference-code payments" },
      "kill.payment.cod": { description: "Cash on delivery" },
      "kill.payment.bnpl": { description: "Buy now pay later (lender-provided; VERIFY BEFORE LAUNCH)" },
      "kill.drops": { description: "Limited drops and the waiting room" },
      "kill.games": { description: "Games and rewards mechanics" },
      "kill.stylist_llm": { description: "LLM stylist" },
      "kill.ml_ranking": { description: "ML ranking; fall back to rules-based ranking" },
      "kill.crawlers": { description: "External catalogue and price crawlers" },
      "kill.referral_payouts": { description: "Referral reward payouts" },
      "kill.gift_card_sales": { description: "Gift card sales" },
    });
    expect(RELEASE_FLAGS).toStrictEqual({
      "release.us_storefront_linkout": {
        description: "US-only web purchase link-out (spec section on App Store storefronts); VERIFY BEFORE LAUNCH",
      },
    });
  });
  it("FLAG_REGISTRY is kill switches then release flags with the right kinds", () => {
    const kills = FLAG_REGISTRY.filter((d) => d.kind === "kill_switch");
    const rels = FLAG_REGISTRY.filter((d) => d.kind === "release");
    expect(kills.map((d) => d.key)).toEqual(Object.keys(KILL_SWITCHES));
    expect(rels.map((d) => d.key)).toEqual(Object.keys(RELEASE_FLAGS));
    expect(FLAG_REGISTRY).toHaveLength(15);
    expect(FLAG_REGISTRY[0]).toStrictEqual({
      key: "kill.payment.card",
      kind: "kill_switch",
      description: "Card payments via the PSP",
      defaultValue: false,
      failClosed: true,
    });
    expect(FLAG_REGISTRY[14]).toStrictEqual({
      key: "release.us_storefront_linkout",
      kind: "release",
      description: RELEASE_FLAGS["release.us_storefront_linkout"].description,
      defaultValue: false,
      failClosed: true,
    });
  });
  it("isKnownFlag", () => {
    expect(isKnownFlag("kill.drops")).toBe(true);
    expect(isKnownFlag("release.us_storefront_linkout")).toBe(true);
    expect(isKnownFlag("kill.nope")).toBe(false);
    expect(isKnownFlag("")).toBe(false);
  });
});

describe("InMemoryFlagProvider exact resolutions", () => {
  it("exposes metadata", () => {
    const p = new InMemoryFlagProvider();
    expect(p.metadata).toEqual({ name: "outlet-in-memory-dev-fixture" });
    expect(p.runsOn).toBe("server");
  });
  it("resolves each type, including falsy values", () => {
    const p = new InMemoryFlagProvider({ b: false, s: "", n: 0, t: true });
    expect(p.resolveBooleanEvaluation("b", true, {})).toEqual({ value: false, reason: "STATIC", variant: "false" });
    expect(p.resolveBooleanEvaluation("t", false, {})).toEqual({ value: true, reason: "STATIC", variant: "true" });
    expect(p.resolveStringEvaluation("s", "d", {})).toEqual({ value: "", reason: "STATIC", variant: "" });
    expect(p.resolveNumberEvaluation("n", 9, {})).toEqual({ value: 0, reason: "STATIC", variant: "0" });
  });
  it("reports missing and mismatched values with the default", () => {
    const p = new InMemoryFlagProvider({ s: "x", n: 1, b: true });
    expect(p.resolveBooleanEvaluation("nope", true, {})).toEqual({
      value: true,
      reason: "ERROR",
      errorCode: "FLAG_NOT_FOUND",
      errorMessage: "unknown flag nope",
    });
    expect(p.resolveBooleanEvaluation("s", false, {})).toEqual({
      value: false,
      reason: "ERROR",
      errorCode: "TYPE_MISMATCH",
      errorMessage: "s is not boolean",
    });
    expect(p.resolveStringEvaluation("n", "d", {})).toEqual({
      value: "d",
      reason: "ERROR",
      errorCode: "TYPE_MISMATCH",
      errorMessage: "n is not string",
    });
    expect(p.resolveNumberEvaluation("b", 7, {})).toEqual({
      value: 7,
      reason: "ERROR",
      errorCode: "TYPE_MISMATCH",
      errorMessage: "b is not number",
    });
    expect(p.resolveStringEvaluation("zzz", "dflt", {}).value).toBe("dflt");
    expect(p.resolveNumberEvaluation("zzz", 5, {}).value).toBe(5);
  });
  it("set overwrites, unset removes, constructor copies initial values", () => {
    const initial: Record<string, boolean> = { a: true };
    const p = new InMemoryFlagProvider(initial);
    initial["a"] = false;
    expect(p.resolveBooleanEvaluation("a", false, {}).value).toBe(true);
    p.set("a", false);
    expect(p.resolveBooleanEvaluation("a", true, {}).value).toBe(false);
    p.unset("a");
    expect(p.resolveBooleanEvaluation("a", true, {}).errorCode).toBe("FLAG_NOT_FOUND");
  });
});

describe("FlagClient exact decisions", () => {
  const stub = (r: () => ResolutionDetails<boolean> | Promise<ResolutionDetails<boolean>>, spy?: (k: string, d: boolean, c: EvaluationContext) => void): FlagProvider => ({
    metadata: { name: "stub" },
    resolveBooleanEvaluation: (k, d, c) => {
      spy?.(k, d, c);
      return r();
    },
    resolveStringEvaluation: () => ({ value: "" }),
    resolveNumberEvaluation: () => ({ value: 0 }),
  });

  it("clean provider values yield source 'provider' and no fallback callback", async () => {
    const seen: FlagDecision[] = [];
    const c = new FlagClient({ provider: new InMemoryFlagProvider({ "kill.drops": true }), onFallback: (d) => seen.push(d) });
    expect(await c.evaluate("kill.drops")).toEqual({ key: "kill.drops", enabled: true, source: "provider" });
    expect(seen).toEqual([]);
  });
  it("unknown flags are closed, flagged as such, and never reach the provider", async () => {
    let called = 0;
    const seen: FlagDecision[] = [];
    const c = new FlagClient({
      provider: stub(() => {
        called += 1;
        return { value: true };
      }),
      onFallback: (d) => seen.push(d),
    });
    expect(await c.evaluate("kill.nope")).toEqual({ key: "kill.nope", enabled: false, source: "default_unknown_flag" });
    expect(called).toBe(0);
    expect(seen).toEqual([{ key: "kill.nope", enabled: false, source: "default_unknown_flag" }]);
  });
  it("passes the key, the registry default and the context to the provider", async () => {
    const calls: [string, boolean, EvaluationContext][] = [];
    const c = new FlagClient({ provider: stub(() => ({ value: true }), (k, d, ctx) => calls.push([k, d, ctx])) });
    await c.isEnabled("kill.games", { targetingKey: "u1", country: "EG" });
    await c.evaluate("kill.games");
    expect(calls).toEqual([
      ["kill.games", false, { targetingKey: "u1", country: "EG" }],
      ["kill.games", false, {}],
    ]);
  });
  it("each fallback path has its own source and reports through onFallback", async () => {
    const seen: FlagDecision[] = [];
    const mk = (r: () => ResolutionDetails<boolean> | Promise<ResolutionDetails<boolean>>) =>
      new FlagClient({ provider: stub(r), onFallback: (d) => seen.push(d) });
    expect(await mk(() => ({ value: true, errorCode: "GENERAL" })).evaluate("kill.drops")).toEqual({
      key: "kill.drops",
      enabled: false,
      source: "default_provider_error",
    });
    expect(
      await mk(() => ({ value: "yes" as unknown as boolean })).evaluate("kill.drops"),
    ).toEqual({ key: "kill.drops", enabled: false, source: "default_invalid_value" });
    expect(
      await mk(() => {
        throw new Error("sync");
      }).evaluate("kill.drops"),
    ).toEqual({ key: "kill.drops", enabled: false, source: "default_provider_threw" });
    expect(await mk(() => Promise.reject(new Error("async"))).evaluate("kill.drops")).toEqual({
      key: "kill.drops",
      enabled: false,
      source: "default_provider_threw",
    });
    expect(seen.map((d) => d.source)).toEqual([
      "default_provider_error",
      "default_invalid_value",
      "default_provider_threw",
      "default_provider_threw",
    ]);
  });
  it("a throwing fallback sink does not change the decision", async () => {
    const c = new FlagClient({
      provider: stub(() => ({ value: true, errorCode: "GENERAL" })),
      onFallback: () => {
        throw new Error("sink");
      },
    });
    await expect(c.evaluate("kill.drops")).resolves.toEqual({
      key: "kill.drops",
      enabled: false,
      source: "default_provider_error",
    });
  });
  it("works without a fallback sink and honours explicit false from the provider", async () => {
    const c = new FlagClient({ provider: stub(() => ({ value: false })) });
    expect(await c.evaluate("kill.drops")).toEqual({ key: "kill.drops", enabled: false, source: "provider" });
    const c2 = new FlagClient({ provider: stub(() => ({ value: "x" as unknown as boolean })) });
    expect(await c2.isEnabled("kill.drops")).toBe(false);
  });
  it("isPaymentMethodEnabled evaluates the matching payment switch with context", async () => {
    const calls: string[] = [];
    const ctxs: EvaluationContext[] = [];
    const c = new FlagClient({
      provider: stub(() => ({ value: true }), (k, _d, ctx) => {
        calls.push(k);
        ctxs.push(ctx);
      }),
    });
    expect(await c.isPaymentMethodEnabled("instapay", { targetingKey: "u" })).toBe(true);
    expect(await c.isPaymentMethodEnabled("apple_pay")).toBe(true);
    expect(calls).toEqual(["kill.payment.instapay", "kill.payment.apple_pay"]);
    expect(ctxs).toEqual([{ targetingKey: "u" }, {}]);
  });
});
