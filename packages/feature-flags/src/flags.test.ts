import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  FLAG_REGISTRY,
  FlagClient,
  InMemoryFlagProvider,
  KILL_SWITCHES,
  PAYMENT_METHODS,
  paymentKillSwitch,
  type FlagDecision,
  type FlagProvider,
  type KillSwitchKey,
} from "./index";

const killKeys = Object.keys(KILL_SWITCHES) as KillSwitchKey[];

describe("registry", () => {
  it("contains every A2.12 kill switch", () => {
    const need = [
      ...PAYMENT_METHODS.map(paymentKillSwitch),
      "kill.payment.cod", "kill.payment.bnpl", "kill.drops", "kill.games", "kill.stylist_llm",
      "kill.ml_ranking", "kill.crawlers", "kill.referral_payouts", "kill.gift_card_sales",
    ];
    for (const k of need) expect(killKeys).toContain(k);
  });
  it("every flag is default-off and fail-closed, keys unique", () => {
    expect(new Set(FLAG_REGISTRY.map((d) => d.key)).size).toBe(FLAG_REGISTRY.length);
    for (const d of FLAG_REGISTRY) {
      expect(d.defaultValue).toBe(false);
      expect(d.failClosed).toBe(true);
    }
  });
});

describe("FlagClient fail-closed", () => {
  it("returns provider value when clean", async () => {
    const p = new InMemoryFlagProvider({ "kill.drops": true });
    const c = new FlagClient({ provider: p });
    expect(await c.isEnabled("kill.drops")).toBe(true);
    p.set("kill.drops", false);
    expect(await c.isEnabled("kill.drops")).toBe(false);
  });

  it("missing value -> closed", async () => {
    const c = new FlagClient({ provider: new InMemoryFlagProvider() });
    for (const k of killKeys) expect(await c.isEnabled(k)).toBe(false);
  });

  it("unknown flag key -> closed even if provider has it", async () => {
    const c = new FlagClient({ provider: new InMemoryFlagProvider({ "kill.nope": true }) });
    expect((await c.evaluate("kill.nope")).enabled).toBe(false);
  });

  it("type mismatch -> closed", async () => {
    const c = new FlagClient({ provider: new InMemoryFlagProvider({ "kill.games": "true" }) });
    expect(await c.isEnabled("kill.games")).toBe(false);
  });

  it("provider throwing or rejecting -> closed, never throws, reports fallback", async () => {
    const seen: FlagDecision[] = [];
    const bad: FlagProvider = {
      ...new InMemoryFlagProvider(),
      metadata: { name: "bad" },
      resolveBooleanEvaluation: () => Promise.reject(new Error("net")),
      resolveStringEvaluation: () => ({ value: "" }),
      resolveNumberEvaluation: () => ({ value: 0 }),
    };
    const c = new FlagClient({ provider: bad, onFallback: (d) => { seen.push(d); throw new Error("sink"); } });
    expect(await c.isEnabled("kill.payment.cod")).toBe(false);
    expect(seen[0]?.source).toBe("default_provider_threw");
  });

  it("provider error code with value true -> closed", async () => {
    const p: FlagProvider = {
      metadata: { name: "x" },
      resolveBooleanEvaluation: () => ({ value: true, errorCode: "PROVIDER_NOT_READY" }),
      resolveStringEvaluation: () => ({ value: "" }),
      resolveNumberEvaluation: () => ({ value: 0 }),
    };
    expect(await new FlagClient({ provider: p }).isEnabled("kill.payment.card")).toBe(false);
  });

  it("payment helper maps to the right switch", async () => {
    const p = new InMemoryFlagProvider({ "kill.payment.fawry": true });
    const c = new FlagClient({ provider: p });
    expect(await c.isPaymentMethodEnabled("fawry")).toBe(true);
    expect(await c.isPaymentMethodEnabled("card")).toBe(false);
  });

  it("property: any non-boolean provider value never enables a flag", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...killKeys), fc.oneof(fc.string(), fc.integer()), async (key, v) => {
        const c = new FlagClient({ provider: new InMemoryFlagProvider({ [key]: v }) });
        expect(await c.isEnabled(key)).toBe(false);
      }),
    );
  });
});
