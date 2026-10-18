import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { CheckoutController, CheckoutWebhookController } from "./adapters/checkout.controller";
import {
  FakeAddresses,
  FakeAgePolicy,
  FakeAppAttest,
  FakeDropAdmission,
  FakeCart,
  FakeCodConfirmation,
  FakeInventory,
  FakeKillSwitch,
  FakeLedger,
  FakeMetrics,
  FakeOrdersIntake,
  FakePaymentProvider,
  FakePromotions,
  FakeRisk,
  FakeStoreCredit,
  FakeTax,
  StaticPaymentRegistry,
} from "./adapters/fakes";
import { InMemorySagaRepository } from "./adapters/in-memory";
import { CheckoutGroupResolver } from "./adapters/resolvers";
import {
  CHECKOUT_CANCEL,
  CHECKOUT_CONFIRM_COD,
  CHECKOUT_CONTEXT,
  CHECKOUT_PLACE,
  CHECKOUT_QUOTE,
  CHECKOUT_RECOVER,
  CHECKOUT_REPOSITORY,
  CHECKOUT_RESOLVER,
  CHECKOUT_STATUS,
  CHECKOUT_WEBHOOK,
} from "./adapters/tokens";
import { PlaceCheckout } from "./application/commit";
import type { CheckoutContext } from "./application/context";
import { CancelCheckout, ConfirmCodOrder, GetCheckoutStatus, RecoverSagas } from "./application/lifecycle";
import { HandlePaymentWebhook } from "./application/payment-events";
import { QuoteCheckout } from "./application/quote";
import type { SagaRepository } from "./domain/ports";

/** Every collaborator is a port. Outside test mode all of them must be supplied (no implicit fakes). */
export type CheckoutPorts = Omit<CheckoutContext, "repo" | "clock" | "ids">;
export interface CheckoutModuleOverrides extends Partial<CheckoutPorts> {
  readonly repository?: SagaRepository;
}

export class MissingCheckoutPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(
      `CheckoutModule requires real ${missing.join(", ")} outside test mode: ` +
        "supply them through CheckoutModule.forRoot(config, overrides)",
    );
    this.name = "MissingCheckoutPortsError";
  }
}

const PORT_NAMES = [
  "cart",
  "promotions",
  "tax",
  "risk",
  "agePolicy",
  "killSwitch",
  "addresses",
  "appAttest",
  "codConfirmation",
  "inventory",
  "credit",
  "payments",
  "ledger",
  "orders",
  "metrics",
  "lockSecret",
] as const;

@Module({})
export class CheckoutModule {
  static forRoot(config: AppConfig, overrides: CheckoutModuleOverrides = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && overrides.repository === undefined) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      const missing = PORT_NAMES.filter((n) => overrides[n] === undefined);
      if (missing.length > 0) throw new MissingCheckoutPortsError(missing);
    }
    return {
      module: CheckoutModule,
      controllers: [CheckoutController, CheckoutWebhookController],
      providers: [
        {
          provide: CHECKOUT_REPOSITORY,
          useFactory: (): SagaRepository => overrides.repository ?? new InMemorySagaRepository(),
        },
        {
          provide: CHECKOUT_CONTEXT,
          inject: [CHECKOUT_REPOSITORY, CLOCK, ID_GENERATOR],
          useFactory: (repo: SagaRepository, clock: Clock, ids: IdGenerator): CheckoutContext => {
            // Test-mode defaults only. Production wiring supplies every port (checked above).
            const inventory = overrides.inventory ?? new FakeInventory(clock);
            return {
              repo,
              clock,
              ids,
              cart: overrides.cart ?? new FakeCart(),
              promotions: overrides.promotions ?? new FakePromotions(),
              tax: overrides.tax ?? new FakeTax(),
              risk: overrides.risk ?? new FakeRisk(),
              agePolicy: overrides.agePolicy ?? new FakeAgePolicy(),
              killSwitch: overrides.killSwitch ?? new FakeKillSwitch(),
              addresses: overrides.addresses ?? new FakeAddresses(),
              appAttest: overrides.appAttest ?? new FakeAppAttest(),
              ...(overrides.dropAdmission !== undefined || config.env === "test"
                ? { dropAdmission: overrides.dropAdmission ?? new FakeDropAdmission() }
                : {}),
              codConfirmation: overrides.codConfirmation ?? new FakeCodConfirmation(),
              inventory,
              credit: overrides.credit ?? new FakeStoreCredit(),
              payments: overrides.payments ?? new StaticPaymentRegistry([new FakePaymentProvider("fake-psp", clock)]),
              ledger: overrides.ledger ?? new FakeLedger(),
              orders: overrides.orders ?? new FakeOrdersIntake(),
              metrics: overrides.metrics ?? new FakeMetrics(),
              lockSecret: overrides.lockSecret ?? "test-only-lock-secret",
              requireAppAttest: overrides.requireAppAttest ?? false,
            };
          },
        },
        { provide: CHECKOUT_QUOTE, inject: [CHECKOUT_CONTEXT], useFactory: (c: CheckoutContext) => new QuoteCheckout(c) },
        { provide: CHECKOUT_PLACE, inject: [CHECKOUT_CONTEXT], useFactory: (c: CheckoutContext) => new PlaceCheckout(c) },
        { provide: CHECKOUT_WEBHOOK, inject: [CHECKOUT_CONTEXT], useFactory: (c: CheckoutContext) => new HandlePaymentWebhook(c) },
        { provide: CHECKOUT_CANCEL, inject: [CHECKOUT_CONTEXT], useFactory: (c: CheckoutContext) => new CancelCheckout(c) },
        { provide: CHECKOUT_CONFIRM_COD, inject: [CHECKOUT_CONTEXT], useFactory: (c: CheckoutContext) => new ConfirmCodOrder(c) },
        { provide: CHECKOUT_STATUS, inject: [CHECKOUT_CONTEXT], useFactory: (c: CheckoutContext) => new GetCheckoutStatus(c) },
        { provide: CHECKOUT_RECOVER, inject: [CHECKOUT_CONTEXT], useFactory: (c: CheckoutContext) => new RecoverSagas(c) },
        { provide: CHECKOUT_RESOLVER, inject: [CHECKOUT_REPOSITORY], useFactory: (r: SagaRepository) => new CheckoutGroupResolver(r) },
      ],
      exports: [CHECKOUT_REPOSITORY, CHECKOUT_CONTEXT, CHECKOUT_RECOVER, CHECKOUT_WEBHOOK],
    };
  }
}
