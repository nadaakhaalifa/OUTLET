import type { RoleSqlClient } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import type { ReservationService } from "@outlet/inventory";
import type { Currency } from "@outlet/money";
import { OutboxWriter, pgTransactionalWriter } from "@outlet/outbox";
import type { TaxRateProviderPort } from "@outlet/tax";
import { UnconfiguredRisk } from "./unconfigured.js";
import type {
  AddressPort, BillingPort, CheckoutConfig, CommissionPort, KillSwitchPort, PaymentProviderPort, PriceSnapshotPort, QuoteTokenPort, RawBodyCipher,
  RefundPort, RiskPort, ShippingQuotePort, StoreCreditPort, SubMerchantPort, TaxCategoryPort,
} from "../ports.js";

/** Ports shared by the request path, the webhook processor and the expiry sweeper. */
export interface CheckoutPorts {
  readonly config: CheckoutConfig;
  readonly reservations: ReservationService;
  readonly provider: PaymentProviderPort;
  readonly shipping: ShippingQuotePort;
  readonly address: AddressPort;
  readonly risk: RiskPort;
  readonly commission: CommissionPort;
  readonly taxCategories: TaxCategoryPort;
  readonly taxRates: TaxRateProviderPort;
  readonly credit: StoreCreditPort;
  readonly tokens: QuoteTokenPort;
  readonly prices: PriceSnapshotPort;
  readonly killSwitches: KillSwitchPort;
  readonly subMerchants: SubMerchantPort;
  readonly billing: BillingPort;
  readonly refunds: RefundPort;
}

/** `risk` is optional: when absent the fail-closed UnconfiguredRisk applies (COD blocked). */
export interface CommonDeps extends Omit<CheckoutPorts, "risk"> {
  readonly risk?: RiskPort;
  readonly marketId: string;
  readonly currency?: Currency;
  readonly outbox?: OutboxWriter;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export interface CheckoutDeps extends CommonDeps {
  /** Connection as outlet_app (ADR-0011); every call binds its own user context. */
  readonly client: RoleSqlClient<"outlet_app">;
}

export interface WorkerDeps extends CommonDeps {
  /** Connection as outlet_worker; the webhook processor and the sweeper bind their own job context. */
  readonly client: RoleSqlClient<"outlet_worker">;
  readonly cipher: RawBodyCipher;
}

export interface Env extends CheckoutPorts {
  readonly marketId: string;
  readonly currency: Currency;
  readonly outbox: OutboxWriter;
  readonly now: () => Date;
  readonly newId: () => string;
}

export const makeEnv = (d: CommonDeps): Env => ({
  ...d,
  risk: d.risk ?? new UnconfiguredRisk(),
  marketId: d.marketId,
  currency: d.currency ?? "EGP",
  outbox: d.outbox ?? new OutboxWriter(pgTransactionalWriter),
  now: d.now ?? (() => new Date()),
  newId: d.newId ?? (() => uuidv7()),
});
