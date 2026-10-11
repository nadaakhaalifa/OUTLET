import "reflect-metadata";
import { describe, expect, it } from "vitest";
import type { ArgumentsHost } from "@nestjs/common";
import { ProblemFilter } from "../platform/problem.filter";
import type { PaymentProviderPort } from "../modules/payments";
import { createProductionFlags } from "./flags";
import { FLAG_REGISTRY } from "../../../../packages/feature-flags/src/index";
import { PROVIDERS, ProviderNotConfiguredError, unconfigured, type ProviderName } from "./unconfigured";
import { FlagBackendOverRegistry } from "./adapters";

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function run(error: unknown): Captured {
  const out: Captured = { status: 0, headers: {}, body: "" };
  const res = {
    setHeader: (k: string, v: string) => {
      out.headers[k] = v;
    },
    status: (s: number) => {
      out.status = s;
      return res;
    },
    end: (b: string) => {
      out.body = b;
    },
  };
  const host = {
    switchToHttp: () => ({ getRequest: () => ({ ctx: { requestId: "req-1" } }), getResponse: () => res }),
  } as unknown as ArgumentsHost;
  new ProblemFilter().catch(error, host);
  return out;
}

describe("Unconfigured providers fail closed at call time", () => {
  const names = Object.keys(PROVIDERS) as ProviderName[];

  it.each(names)("%s: any call throws ProviderNotConfiguredError and never returns a value", (name) => {
    const port = unconfigured<{ doSomething(x: number): Promise<string> }>(name);
    expect(() => port.doSomething(1)).toThrow(ProviderNotConfiguredError);
    let returned = false;
    try {
      void port.doSomething(1);
      returned = true;
    } catch {
      // expected
    }
    expect(returned).toBe(false);
  });

  it("is invisible to Nest lifecycle and promise introspection", () => {
    const port = unconfigured<Record<string, unknown>>("psp.paymob");
    for (const hook of ["onModuleInit", "onApplicationBootstrap", "onModuleDestroy", "then", "toJSON"]) {
      expect(port[hook], hook).toBeUndefined();
    }
  });

  it("maps to 503 Problem+JSON with code provider_not_configured and leaks nothing else", () => {
    const err = (() => {
      try {
        unconfigured<{ charge(): void }>("psp.paymob").charge();
      } catch (e) {
        return e;
      }
      return null;
    })();
    const res = run(err);
    expect(res.status).toBe(503);
    expect(res.headers["Content-Type"]).toContain("application/problem+json");
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 503, code: "provider_not_configured", provider: "psp.paymob", request_id: "req-1" });
    expect(JSON.stringify(body)).not.toMatch(/stack|charge/);
  });

  it("an Unconfigured PSP keeps its static id but every operation is a 503, never an ok result", () => {
    const psp = unconfigured<PaymentProviderPort>("psp.paymob", { id: "paymob", methods: ["card"] });
    expect(psp.id).toBe("paymob");
    expect(() => psp.createIntent({} as never)).toThrow(ProviderNotConfiguredError);
    expect(() => psp.verifyWebhook({} as never)).toThrow(ProviderNotConfiguredError);
    expect(() => psp.refund({} as never)).toThrow(ProviderNotConfiguredError);
  });
});

describe("capabilities are Blocked by the flag registry default", () => {
  it("every registry flag evaluates to false with the unconfigured provider", async () => {
    const flags = createProductionFlags();
    for (const f of FLAG_REGISTRY) {
      expect(await flags.client.isEnabled(f.key), f.key).toBe(false);
    }
  });

  it("module flag ports are all blocked and payment methods are all disabled", async () => {
    const f = createProductionFlags();
    expect(await f.gift.salesEnabled()).toBe(false);
    expect(await f.gift.redemptionEnabled()).toBe(false);
    expect(await f.rewards.gamesEnabled()).toBe(false);
    expect(await f.crawl.crawlingEnabled()).toBe(false);
    expect(await f.mlRanking.mlRankingAllowed()).toBe(false);
    expect(await f.switches.allowed("drops_all")).toBe(false);
    expect(await f.switches.allowed("drop_type_flash_hour")).toBe(false);
    expect(await f.gate.enabled("kill.stylist_llm")).toBe(false);
    expect(await f.gate.enabled("not.a.flag")).toBe(false);
    expect(await f.payouts.payoutsEnabled()).toBe(false);
    expect([...(await f.checkoutKill.disabledMethods())].sort()).toEqual(
      ["apple_pay", "bnpl", "card", "cod", "fawry", "instapay", "meeza", "mobile_wallet"],
    );
    for (const m of ["card", "meeza", "apple_pay", "mobile_wallet", "instapay", "fawry"] as const) {
      expect(await f.paymentMethodSwitch.isEnabled(m), m).toBe(false);
    }
    // Typesense is disabled when its switch is blocked.
    expect(await f.search.typesenseDisabled()).toBe(true);
  });

  it("the admin flag console reports blocked and refuses writes without a provider", async () => {
    const f = createProductionFlags();
    const backend = new FlagBackendOverRegistry(f.client);
    const all = await backend.list();
    expect(all.length).toBe(FLAG_REGISTRY.length);
    expect(all.every((v) => !v.enabled && v.isDefault)).toBe(true);
    await expect(backend.set()).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });
});
