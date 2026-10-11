import type { Clock, IdGenerator } from "../../../platform/ports";
import type {
  AddressPort,
  AgePolicyPort,
  AppAttestPort,
  CartPort,
  CodConfirmationPort,
  InventoryPort,
  KillSwitchPort,
  LedgerPort,
  MetricsPort,
  OrdersIntakePort,
  PaymentRegistry,
  PromotionsPort,
  RiskPort,
  SagaRepository,
  StoreCreditPort,
  TaxPort,
} from "../domain/ports";

/** Everything the use cases need. One bag, built once by the module (or a test). */
export interface CheckoutContext {
  readonly repo: SagaRepository;
  readonly cart: CartPort;
  readonly promotions: PromotionsPort;
  readonly tax: TaxPort;
  readonly risk: RiskPort;
  readonly agePolicy: AgePolicyPort;
  readonly killSwitch: KillSwitchPort;
  readonly addresses: AddressPort;
  readonly appAttest: AppAttestPort;
  readonly codConfirmation: CodConfirmationPort;
  readonly inventory: InventoryPort;
  readonly credit: StoreCreditPort;
  readonly payments: PaymentRegistry;
  readonly ledger: LedgerPort;
  readonly orders: OrdersIntakePort;
  readonly metrics: MetricsPort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** HMAC key for price-lock tokens. Required outside tests. */
  readonly lockSecret: string;
  /** Flag `checkout.require_app_attest` (spec 7, API6). */
  readonly requireAppAttest: boolean;
}
