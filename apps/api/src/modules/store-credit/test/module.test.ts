import "reflect-metadata";
import { Global, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../config/env";
import { AUTHENTICATOR, PlatformModule } from "../../../platform";
import { CREDIT_HOLDS, GIFT_CARD_SALES_GATE, InMemoryCreditLedger, InMemoryStoreCredit, StoreCreditModule } from "../index";
import { RefundsModule } from "../../refunds/index";

@Global()
@Module({ providers: [{ provide: AUTHENTICATOR, useValue: { authenticate: async () => null } }], exports: [AUTHENTICATOR] })
class NoAuthModule {}

const boot = async (giftCardSalesEnabled?: boolean) => {
  const config = loadConfig({ NODE_ENV: "test" });
  return Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config),
      NoAuthModule,
      StoreCreditModule.forRoot(config, giftCardSalesEnabled === undefined ? {} : { giftCardSalesEnabled }),
    ],
  }).compile();
};

describe("store credit module wiring", () => {
  it("gift card sales are OFF by default (kill switch)", async () => {
    const m = await boot();
    const gate = m.get<{ enabled(): boolean; assertEnabled(): void }>(GIFT_CARD_SALES_GATE, { strict: false });
    expect(gate.enabled()).toBe(false);
    expect(() => gate.assertEnabled()).toThrow();
  });

  it("can be switched on only by explicit configuration", async () => {
    const m = await boot(true);
    const gate = m.get<{ enabled(): boolean; assertEnabled(): void }>(GIFT_CARD_SALES_GATE, { strict: false });
    expect(gate.enabled()).toBe(true);
    expect(() => gate.assertEnabled()).not.toThrow();
  });

  it("refuses to boot in production without real adapters", () => {
    const prod = loadConfig({ NODE_ENV: "test" });
    const forced = { ...prod, adapters: "production" } as const;
    expect(() => StoreCreditModule.forRoot(forced)).toThrow();
    expect(() => RefundsModule.forRoot(forced)).toThrow();
  });

  it("R-6: wires the liveness guard (fail closed in production without a port, dev fake otherwise)", async () => {
    const prod = loadConfig({ NODE_ENV: "test" });
    const forced = { ...prod, adapters: "production" } as const;
    const store = new InMemoryStoreCredit();
    const ports = { store, ledger: new InMemoryCreditLedger() };
    expect(() => StoreCreditModule.forRoot(forced, ports)).toThrow(/holdLiveness/);
    const mod = StoreCreditModule.forRoot(forced, { ...ports, holdLiveness: { isLive: async () => false } });
    expect(mod.providers?.length).toBeGreaterThan(0);
    const m = await Test.createTestingModule({
      imports: [
        PlatformModule.forRoot(prod),
        NoAuthModule,
        StoreCreditModule.forRoot(prod, { holdLiveness: { isLive: async () => true } }),
      ],
    }).compile();
    expect(m.get(CREDIT_HOLDS, { strict: false })).toBeDefined();
  });
});
