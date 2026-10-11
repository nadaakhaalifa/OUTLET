import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import {
  CapturePayment,
  CreatePaymentIntent,
  DeleteSavedCard,
  ExpirePaymentIntents,
  ListPaymentMethods,
  ListSavedCards,
  ProcessPaymentWebhook,
  ReceiveWebhook,
  RefundPayment,
  VoidPayment,
} from "./application/payments";
import { PspRouter, type PspRouterOptions } from "./application/psp-router";
import { FakePaymentProvider } from "./adapters/fake-provider";
import { StaticPaymentMethodSwitch } from "./adapters/flag-switch";
import { InMemoryPaymentStore } from "./adapters/in-memory-store";
import { AllowAllIps } from "./adapters/ip-allowlist";
import { PaymentsController, PaymentWebhooksController } from "./adapters/payments.controller";
import {
  PAYMENT_CAPTURE,
  PAYMENT_CREATE_INTENT,
  PAYMENT_DELETE_CARD,
  PAYMENT_EXPIRE_INTENTS,
  PAYMENT_ID_PORT,
  PAYMENT_IP_ALLOW_LIST,
  PAYMENT_LIST_CARDS,
  PAYMENT_LIST_METHODS,
  PAYMENT_METHOD_SWITCH,
  PAYMENT_PROCESS_WEBHOOK,
  PAYMENT_PSP_ROUTER,
  PAYMENT_RECEIVE_WEBHOOK,
  PAYMENT_REFUND,
  PAYMENT_STORE,
  PAYMENT_VOID,
} from "./adapters/tokens";
import type { IdPort, PaymentMethodSwitchPort, PaymentProviderPort, PaymentStore, WebhookIpAllowListPort } from "./domain/ports";
import { DEFAULT_BREAKER_CONFIG, type RoutePolicy } from "./domain/seam";

export interface PaymentsModuleOverrides {
  readonly store?: PaymentStore;
  readonly providers?: readonly PaymentProviderPort[];
  readonly methodSwitch?: PaymentMethodSwitchPort;
  readonly ipAllowList?: WebhookIpAllowListPort;
  readonly policy?: RoutePolicy;
  readonly router?: Partial<Pick<PspRouterOptions, "breaker" | "maxAttempts" | "sleep" | "random">>;
}

/** Thrown at boot when a non-test environment lacks a real provider, switch or IP allow-list. */
export class MissingPaymentsPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(
      `PaymentsModule requires real ${missing.join(", ")} outside in-memory-dev: ` +
        "supply them through PaymentsModule.forRoot(config, overrides)",
    );
    this.name = "MissingPaymentsPortsError";
  }
}

@Module({})
export class PaymentsModule {
  static forRoot(config: AppConfig, overrides: PaymentsModuleOverrides = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && overrides.store === undefined) throw new NoProductionAdaptersError();
    if (production) {
      const missing = [
        ...(overrides.providers === undefined || overrides.providers.length === 0 ? ["providers (PaymentProviderPort[])"] : []),
        ...(overrides.methodSwitch === undefined ? ["methodSwitch (kill switches from packages/feature-flags)"] : []),
        ...(overrides.ipAllowList === undefined ? ["ipAllowList (webhook source IPs)"] : []),
      ];
      if (missing.length > 0) throw new MissingPaymentsPortsError(missing);
    }
    return {
      module: PaymentsModule,
      controllers: [PaymentWebhooksController, PaymentsController],
      providers: [
        {
          provide: PAYMENT_ID_PORT,
          inject: [ID_GENERATOR],
          useFactory: (ids: IdGenerator): IdPort => ({ uuidV7: () => ids.uuidV7() }),
        },
        {
          provide: PAYMENT_STORE,
          inject: [CLOCK, ID_GENERATOR],
          useFactory: (clock: Clock, ids: IdGenerator): PaymentStore =>
            overrides.store ?? new InMemoryPaymentStore(clock, () => ids.uuidV7()),
        },
        { provide: PAYMENT_METHOD_SWITCH, useValue: overrides.methodSwitch ?? new StaticPaymentMethodSwitch() },
        { provide: PAYMENT_IP_ALLOW_LIST, useValue: overrides.ipAllowList ?? new AllowAllIps() },
        {
          provide: PAYMENT_PSP_ROUTER,
          inject: [CLOCK],
          useFactory: (clock: Clock): PspRouter => {
            const providers = overrides.providers ?? [new FakePaymentProvider("fake_psp", undefined, undefined, () => clock.nowMs())];
            const policy: RoutePolicy =
              overrides.policy ?? { order: {}, defaultOrder: providers.map((p) => p.id) };
            return new PspRouter(new Map(providers.map((p) => [p.id, p] as const)), clock, {
              policy,
              breaker: overrides.router?.breaker ?? DEFAULT_BREAKER_CONFIG,
              maxAttempts: overrides.router?.maxAttempts ?? 3,
              sleep: overrides.router?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
              random: overrides.router?.random ?? Math.random,
            });
          },
        },
        {
          provide: PAYMENT_LIST_METHODS,
          inject: [PAYMENT_METHOD_SWITCH, PAYMENT_PSP_ROUTER],
          useFactory: (sw: PaymentMethodSwitchPort, r: PspRouter) => new ListPaymentMethods(sw, r),
        },
        {
          provide: PAYMENT_CREATE_INTENT,
          inject: [PAYMENT_STORE, PAYMENT_PSP_ROUTER, PAYMENT_METHOD_SWITCH, CLOCK, PAYMENT_ID_PORT],
          useFactory: (s: PaymentStore, r: PspRouter, sw: PaymentMethodSwitchPort, c: Clock, ids: IdPort) =>
            new CreatePaymentIntent(s, r, sw, c, ids),
        },
        {
          provide: PAYMENT_CAPTURE,
          inject: [PAYMENT_STORE, PAYMENT_PSP_ROUTER],
          useFactory: (s: PaymentStore, r: PspRouter) => new CapturePayment(s, r),
        },
        {
          provide: PAYMENT_VOID,
          inject: [PAYMENT_STORE, PAYMENT_PSP_ROUTER],
          useFactory: (s: PaymentStore, r: PspRouter) => new VoidPayment(s, r),
        },
        {
          provide: PAYMENT_REFUND,
          inject: [PAYMENT_STORE, PAYMENT_PSP_ROUTER, CLOCK, PAYMENT_ID_PORT],
          useFactory: (s: PaymentStore, r: PspRouter, c: Clock, ids: IdPort) => new RefundPayment(s, r, c, ids),
        },
        {
          provide: PAYMENT_RECEIVE_WEBHOOK,
          inject: [PAYMENT_STORE, PAYMENT_PSP_ROUTER, PAYMENT_IP_ALLOW_LIST, CLOCK, PAYMENT_ID_PORT],
          useFactory: (s: PaymentStore, r: PspRouter, ip: WebhookIpAllowListPort, c: Clock, ids: IdPort) =>
            new ReceiveWebhook(s, r, ip, c, ids),
        },
        {
          provide: PAYMENT_PROCESS_WEBHOOK,
          inject: [PAYMENT_STORE, PAYMENT_PSP_ROUTER, CLOCK, PAYMENT_ID_PORT],
          useFactory: (s: PaymentStore, r: PspRouter, c: Clock, ids: IdPort) => new ProcessPaymentWebhook(s, r, c, ids),
        },
        {
          provide: PAYMENT_EXPIRE_INTENTS,
          inject: [PAYMENT_STORE, PAYMENT_PSP_ROUTER, CLOCK],
          useFactory: (s: PaymentStore, r: PspRouter, c: Clock) => new ExpirePaymentIntents(s, r, c),
        },
        { provide: PAYMENT_LIST_CARDS, inject: [PAYMENT_STORE], useFactory: (s: PaymentStore) => new ListSavedCards(s) },
        {
          provide: PAYMENT_DELETE_CARD,
          inject: [PAYMENT_STORE, PAYMENT_PSP_ROUTER, CLOCK],
          useFactory: (s: PaymentStore, r: PspRouter, c: Clock) => new DeleteSavedCard(s, r, c),
        },
      ],
      exports: [
        PAYMENT_STORE,
        PAYMENT_PSP_ROUTER,
        PAYMENT_LIST_METHODS,
        PAYMENT_CREATE_INTENT,
        PAYMENT_CAPTURE,
        PAYMENT_VOID,
        PAYMENT_REFUND,
        PAYMENT_PROCESS_WEBHOOK,
        PAYMENT_EXPIRE_INTENTS,
      ],
    };
  }
}
