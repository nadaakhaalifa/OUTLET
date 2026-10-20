import { describe, expect, it } from "vitest";
import { FlagClient, InMemoryFlagProvider } from "../../../../../../packages/feature-flags/src/index";
import { FlagPaymentMethodSwitch } from "../adapters/flag-switch";
import { PAYMENT_METHOD_IDS } from "../domain/seam";

describe("FlagPaymentMethodSwitch over packages/feature-flags", () => {
  it("is fail-closed: with no provider values every method is off", async () => {
    const sw = new FlagPaymentMethodSwitch(new FlagClient({ provider: new InMemoryFlagProvider() }));
    for (const m of PAYMENT_METHOD_IDS) expect(await sw.isEnabled(m)).toBe(false);
  });

  it("maps methods to their family switch and meeza shares the card switch", async () => {
    const p = new InMemoryFlagProvider({ "kill.payment.card": true, "kill.payment.fawry": false, "kill.payment.apple_pay": true });
    const sw = new FlagPaymentMethodSwitch(new FlagClient({ provider: p }));
    expect(await sw.isEnabled("card")).toBe(true);
    expect(await sw.isEnabled("meeza")).toBe(true);
    expect(await sw.isEnabled("apple_pay")).toBe(true);
    expect(await sw.isEnabled("fawry")).toBe(false);
    expect(await sw.isEnabled("instapay")).toBe(false);
    p.set("kill.payment.card", false);
    expect(await sw.isEnabled("meeza")).toBe(false);
  });

  it("a provider that throws or returns a non-boolean turns the method off", async () => {
    const throwing = new FlagClient({
      provider: {
        metadata: { name: "boom" },
        runsOn: "server",
        resolveBooleanEvaluation: () => {
          throw new Error("down");
        },
        resolveStringEvaluation: () => {
          throw new Error("down");
        },
        resolveNumberEvaluation: () => {
          throw new Error("down");
        },
        resolveObjectEvaluation: () => {
          throw new Error("down");
        },
      } as never,
    });
    expect(await new FlagPaymentMethodSwitch(throwing).isEnabled("card")).toBe(false);
  });
});
