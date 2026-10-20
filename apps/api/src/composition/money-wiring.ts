import { randomBytes } from "node:crypto";
import {
  InboxConsumer,
  OutboxRelay,
  type Clock as OutboxClock,
  type InboxStore,
  type OutboxMessage,
  type OutboxStore,
  type Publisher,
  type Random as OutboxRandom,
  type RelayConfig,
  type UnitOfWork,
} from "@outlet/outbox";
import { Inject, Injectable, Module, type DynamicModule, type OnApplicationBootstrap } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import type { AppConfig } from "../config/env";
import type { PersistenceWiring } from "../persistence";
import { ADMIN_STORE, type AdminStore } from "../modules/admin";
import {
  CART_CATALOG,
  CART_MEMBERSHIP,
  CART_REPOSITORY,
  QUOTE_BAG_FOR_CHECKOUT,
  type CartRepository,
  type CatalogPort,
  type MembershipPort,
  type QuoteBagForCheckout,
} from "../modules/cart";
import {
  CHECKOUT_WEBHOOK,
  CHECKOUT_REPOSITORY,
  SagaHoldLiveness,
  type SagaRepository,
  FakeAddresses,
  FakeAgePolicy,
  FakeAppAttest,
  FakeCodConfirmation,
  FakeKillSwitch,
  FakeMetrics,
  FakeRisk,
  type CheckoutModuleOverrides,
  type HandlePaymentWebhook,
} from "../modules/checkout";
import {
  INVENTORY_CLAIM_RESERVATION,
  INVENTORY_RELEASE_RESERVATION,
  INVENTORY_RESERVE_STOCK,
  INVENTORY_SKU_DIRECTORY,
  type ClaimReservation,
  type ReleaseReservation,
  type ReserveStock,
  type SkuDirectory,
} from "../modules/inventory";
import {
  InMemoryLedger,
  LEDGER_PROJECTION,
  LEDGER_READ_MODEL,
  LEDGER_SNAPSHOTS,
  LEDGER_STORE,
  POSTING_SERVICE,
  type IntegritySnapshots,
  type LedgerModuleOverrides,
  type LedgerReadModel,
  type LedgerStore,
  type LedgerTxn,
  type PostingService,
  type ProjectionSource,
} from "../modules/ledger";
import { ORDER_PLACE, type PlaceOrders } from "../modules/orders";
import {
  PAYMENT_CREATE_INTENT,
  PAYMENT_REFUND,
  PAYMENT_VOID,
  type CreatePaymentIntent,
  type PaymentsModuleOverrides,
  type RefundPayment,
  type VoidPayment,
} from "../modules/payments";
import {
  FakeFlags,
  FakeIbanNameMatch,
  FakePayoutPort,
  FakePayoutRisk,
  FakePayoutSource,
  FakeSellerBank,
  type PayoutsModuleOverrides,
} from "../modules/payouts";
import { EVALUATE_PROMOTIONS, type EvaluatePromotions } from "../modules/promotions";
import {
  FakeEtaSource,
  FakeReconAlerts,
  FakeReconFlags,
  type FileKind,
  type LedgerClearingPort,
  type ReconciliationModuleOverrides,
} from "../modules/reconciliation";
import type { RefundsModuleOverrides } from "../modules/refunds";
import {
  CREDIT_HOLDS,
  RESTORE_REFUND_CREDIT,
  STORE_CREDIT_STORE,
  type CreditHolds,
  type RestoreRefundCredit,
  type StoreCreditModuleOverrides,
  type StoreCreditStore,
} from "../modules/store-credit";
import { QUOTE_ORDER_TAX, type QuoteOrderTax } from "../modules/tax-eta";
import { systemClock } from "../platform/system-adapters";
import { createIdGenerator, nodeCsprng } from "../platform/system-adapters";
import {
  CartAdapter,
  InventoryAdapter,
  OrdersAdapter,
  PaymentsModuleProvider,
  PaymentsRegistry,
  PromotionsAdapter,
  StoreCreditAdapter,
  TaxAdapter,
  type CommerceTermsPort,
} from "./checkout-adapters";
import { chart } from "./domain";
import { Late } from "./late";
import { LedgerGateway } from "./ledger-gateway";
import {
  AdminPayoutApprovals,
  LedgerIntegrityPort,
  PaymentEventsToCheckout,
  StoreCreditProjection,
  type BridgedEvent,
} from "./money-adapters";

// ------------------------------------------------------------------ I-4: commerce terms that refuse

/** A store has no registered seller-agreement terms: the quote must fail, never default a commission. */
export class UnknownStoreTermsError extends Error {
  constructor(readonly storeId: string) {
    super(`no commerce terms registered for store ${storeId}`);
    this.name = "UnknownStoreTermsError";
  }
}

/** Injection token for the registry so seller onboarding (and tests) can register agreed terms. */
export const COMMERCE_TERMS_REGISTRY = Symbol("outlet.commerceTermsRegistry");

/**
 * Seller-agreement commission per store. There is NO default: an unknown store throws
 * `UnknownStoreTermsError`, so checkout fails closed instead of pricing with an invented rate
 * (VERIFY BEFORE LAUNCH VR-INT-01 supplies the real source). Tax category defaults to the
 * standard VAT category (spec B4: default 14%, admin-editable exemptions), which is a legal
 * default and not a commercial one.
 */
export class RegisteredCommerceTerms implements CommerceTermsPort {
  private readonly bps = new Map<string, number>();

  register(storeId: string, commissionBps: number): void {
    if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > 10_000) {
      throw new RangeError("commissionBps must be an integer in 0..10000");
    }
    this.bps.set(storeId, commissionBps);
  }

  async commissionBps(storeId: string): Promise<number> {
    const v = this.bps.get(storeId);
    if (v === undefined) throw new UnknownStoreTermsError(storeId);
    return v;
  }

  async taxCategoryCode(): Promise<string> {
    return "standard";
  }
}

// ------------------------------------------------------------------ I-2: payments outbox -> checkout

export const PAYMENT_EVENTS_CONSUMER = "checkout.payment-events";

/** Maps a relayed outbox message to the slice the bridge reads. */
export function toBridgedEvent(m: OutboxMessage): BridgedEvent {
  return { id: m.messageId, type: m.eventType, occurredAtMs: m.occurredAt.getTime(), payload: m.payload };
}

/**
 * Relay publisher: delivers payments events to the checkout saga bridge exactly once per message
 * id as far as database effects go (inbox row, same unit of work). A throw (malformed payload,
 * saga error) rolls the inbox row back so the relay retries, then dead-letters. Events checkout
 * does not consume (refunds, voids, anomalies) are acknowledged as skipped: refunds are owned by
 * the refunds module, the saga has no refund transition.
 */
export class PaymentEventsPublisher<Tx> implements Publisher {
  constructor(
    private readonly inbox: InboxConsumer<Tx>,
    private readonly bridge: PaymentEventsToCheckout,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.inbox.consume({
      consumer: PAYMENT_EVENTS_CONSUMER,
      messageId: message.messageId,
      handler: async () => {
        await this.bridge.handle(toBridgedEvent(message));
      },
    });
  }
}

export interface PaymentRelayDeps<Tx> {
  readonly store: OutboxStore<Tx>;
  readonly uow: UnitOfWork<Tx>;
  readonly inbox: InboxStore<Tx>;
  readonly clock: OutboxClock;
  readonly random: OutboxRandom;
  readonly bridge: PaymentEventsToCheckout;
  readonly config?: RelayConfig;
}

const DEFAULT_RELAY: RelayConfig = {
  batchSize: 50,
  maxAttempts: 8,
  backoff: { baseMs: 500, capMs: 60_000 },
};

/** Builds the relay that drives `PaymentEventsToCheckout`. `runOnce()` is called by a scheduler. */
export function createPaymentEventsRelay<Tx>(d: PaymentRelayDeps<Tx>): OutboxRelay<Tx> {
  const inbox = new InboxConsumer<Tx>({ uow: d.uow, inbox: d.inbox, clock: d.clock });
  return new OutboxRelay<Tx>(
    { store: d.store, publisher: new PaymentEventsPublisher(inbox, d.bridge), clock: d.clock, random: d.random },
    d.config ?? DEFAULT_RELAY,
  );
}

// ------------------------------------------------------------------ I-3: ledger -> reconciliation

const CLEARING_ACCOUNT: Record<FileKind, (party: string) => string> = {
  psp: (p) => chart.pspClearing(p),
  cod: (p) => chart.codClearing(p),
  bnpl: (p) => chart.bnplClearing(p),
};
const SETTLE_KEY: Record<FileKind, string> = { psp: "psp_settled", cod: "cod_collected", bnpl: "bnpl_settled" };
const CHAIN_PAGE = 500;

/**
 * Real `LedgerClearingPort` over the ledger public surface. Lines are the postings on the party's
 * clearing account from the hash-chain snapshot; settlement entries themselves (kind
 * `clearing_settled`) are excluded because they are the thing being reconciled. The line key is
 * the entry reference id (order group, refund id), which the provider file must echo as the
 * merchant reference (VERIFY BEFORE LAUNCH VR-F1-11). Amounts keep the ledger sign (debit +).
 * The scan reads the chain in pages inside one consistent snapshot; a date index is a later
 * optimisation for the Postgres adapter.
 */
export class LedgerClearingAdapter implements LedgerClearingPort {
  constructor(private readonly snapshots: Late<IntegritySnapshots>) {}

  async clearingLines(q: { kind: FileKind; party: string; fromMs: number; toMs: number }) {
    const account = CLEARING_ACCOUNT[q.kind](q.party);
    return this.snapshots.get().withSnapshot(async (src) => {
      const out: { id: string; key: string; amount: bigint; atMs: number }[] = [];
      let after: bigint | null = null;
      for (;;) {
        const rows = await src.chainPage(after, CHAIN_PAGE);
        for (const { entry } of rows) {
          if (entry.kind === "clearing_settled") continue;
          const at = entry.occurredAt.getTime();
          if (at < q.fromMs || at > q.toMs) continue;
          entry.postings.forEach((p, i) => {
            if (p.account === account) out.push({ id: `${entry.id}:${i}`, key: entry.ref.id, amount: p.amount.amount, atMs: at });
          });
        }
        if (rows.length < CHAIN_PAGE) break;
        const last = rows[rows.length - 1];
        if (last === undefined) break;
        after = last.link.seq;
      }
      return out;
    });
  }

  async postedSettlement(q: { kind: FileKind; party: string; settlementId: string }) {
    const key = `${SETTLE_KEY[q.kind]}:${q.settlementId}`;
    const account = CLEARING_ACCOUNT[q.kind](q.party);
    return this.snapshots.get().withSnapshot(async (src) => {
      let after: bigint | null = null;
      for (;;) {
        const rows = await src.chainPage(after, CHAIN_PAGE);
        for (const { entry } of rows) {
          if (entry.idempotencyKey !== key) continue;
          const clearing = entry.postings.find((p) => p.account === account);
          const bank = entry.postings.find((p) => p.account.startsWith("bank_settlement:"));
          if (clearing === undefined || bank === undefined) return null;
          const gross = -clearing.amount.amount;
          return { gross, fee: gross - bank.amount.amount };
        }
        if (rows.length < CHAIN_PAGE) return null;
        const last = rows[rows.length - 1];
        if (last === undefined) return null;
        after = last.link.seq;
      }
    });
  }
}

/** Everything the bridge fills once the container exists. */
export interface MoneyLates {
  readonly quoteBag: Late<QuoteBagForCheckout>;
  readonly catalog: Late<CatalogPort>;
  readonly membership: Late<MembershipPort>;
  readonly cartRepo: Late<CartRepository>;
  readonly directory: Late<SkuDirectory>;
  readonly reserve: Late<ReserveStock>;
  readonly claim: Late<ClaimReservation>;
  readonly release: Late<ReleaseReservation>;
  readonly promotions: Late<EvaluatePromotions>;
  readonly tax: Late<QuoteOrderTax>;
  readonly orders: Late<PlaceOrders>;
  readonly holds: Late<CreditHolds>;
  readonly creditStore: Late<StoreCreditStore>;
  readonly restoreCredit: Late<RestoreRefundCredit>;
  readonly createIntent: Late<CreatePaymentIntent>;
  readonly voidPayment: Late<VoidPayment>;
  readonly refundPayment: Late<RefundPayment>;
  readonly posting: Late<PostingService<LedgerTxn>>;
  readonly ledgerStore: Late<LedgerStore<LedgerTxn>>;
  readonly ledgerReads: Late<LedgerReadModel>;
  readonly ledgerSnapshots: Late<IntegritySnapshots>;
  readonly ledgerProjection: Late<ProjectionSource>;
  readonly checkoutWebhook: Late<HandlePaymentWebhook>;
  readonly sagas: Late<SagaRepository>;
  readonly adminStore: Late<AdminStore>;
  /** Registered seller-agreement terms (no default). Seller onboarding registers a store here. */
  readonly terms: RegisteredCommerceTerms;
}

export function createMoneyLates(): MoneyLates {
  return {
    quoteBag: new Late("cart.QuoteBagForCheckout"),
    catalog: new Late("cart.CatalogPort"),
    membership: new Late("cart.MembershipPort"),
    cartRepo: new Late("cart.CartRepository"),
    directory: new Late("inventory.SkuDirectory"),
    reserve: new Late("inventory.ReserveStock"),
    claim: new Late("inventory.ClaimReservation"),
    release: new Late("inventory.ReleaseReservation"),
    promotions: new Late("promotions.EvaluatePromotions"),
    tax: new Late("tax.QuoteOrderTax"),
    orders: new Late("orders.PlaceOrders"),
    holds: new Late("storeCredit.CreditHolds"),
    creditStore: new Late("storeCredit.Store"),
    restoreCredit: new Late("storeCredit.RestoreRefundCredit"),
    createIntent: new Late("payments.CreatePaymentIntent"),
    voidPayment: new Late("payments.VoidPayment"),
    refundPayment: new Late("payments.RefundPayment"),
    posting: new Late("ledger.PostingService"),
    ledgerStore: new Late("ledger.Store"),
    ledgerReads: new Late("ledger.ReadModel"),
    ledgerSnapshots: new Late("ledger.Snapshots"),
    ledgerProjection: new Late("ledger.Projection"),
    checkoutWebhook: new Late("checkout.HandlePaymentWebhook"),
    sagas: new Late("checkout.SagaRepository"),
    adminStore: new Late("admin.Store"),
    terms: new RegisteredCommerceTerms(),
  };
}

const BINDINGS: readonly (readonly [keyof MoneyLates, symbol])[] = [
  ["quoteBag", QUOTE_BAG_FOR_CHECKOUT],
  ["catalog", CART_CATALOG],
  ["membership", CART_MEMBERSHIP],
  ["cartRepo", CART_REPOSITORY],
  ["directory", INVENTORY_SKU_DIRECTORY],
  ["reserve", INVENTORY_RESERVE_STOCK],
  ["claim", INVENTORY_CLAIM_RESERVATION],
  ["release", INVENTORY_RELEASE_RESERVATION],
  ["promotions", EVALUATE_PROMOTIONS],
  ["tax", QUOTE_ORDER_TAX],
  ["orders", ORDER_PLACE],
  ["holds", CREDIT_HOLDS],
  ["creditStore", STORE_CREDIT_STORE],
  ["restoreCredit", RESTORE_REFUND_CREDIT],
  ["createIntent", PAYMENT_CREATE_INTENT],
  ["voidPayment", PAYMENT_VOID],
  ["refundPayment", PAYMENT_REFUND],
  ["posting", POSTING_SERVICE],
  ["ledgerStore", LEDGER_STORE],
  ["ledgerReads", LEDGER_READ_MODEL],
  ["ledgerSnapshots", LEDGER_SNAPSHOTS],
  ["ledgerProjection", LEDGER_PROJECTION],
  ["checkoutWebhook", CHECKOUT_WEBHOOK],
  ["sagas", CHECKOUT_REPOSITORY],
  ["adminStore", ADMIN_STORE],
];

const LATES = Symbol("outlet.moneyLates");

/**
 * Binds every `Late` from the built container at bootstrap, by token, across modules. This is the
 * single place where a module's provider reaches another module's adapter, and it only uses tokens
 * the owning module exports from its public index.
 */
@Injectable()
class MoneyBridge implements OnApplicationBootstrap {
  constructor(
    @Inject(ModuleRef) private readonly ref: ModuleRef,
    @Inject(LATES) private readonly lates: MoneyLates,
  ) {}

  onApplicationBootstrap(): void {
    for (const [name, token] of BINDINGS) {
      const value: unknown = this.ref.get(token, { strict: false });
      (this.lates[name] as Late<unknown>).bind(value);
    }
  }
}

@Module({})
export class MoneyBridgeModule {
  static forRoot(lates: MoneyLates): DynamicModule {
    return { module: MoneyBridgeModule, providers: [{ provide: LATES, useValue: lates }, { provide: COMMERCE_TERMS_REGISTRY, useValue: lates.terms }, MoneyBridge] };
  }
}

export interface MoneyWiring {
  readonly ledger: LedgerModuleOverrides;
  readonly payments: PaymentsModuleOverrides;
  readonly checkout: CheckoutModuleOverrides;
  readonly refunds: RefundsModuleOverrides;
  readonly storeCredit: StoreCreditModuleOverrides;
  readonly payouts: PayoutsModuleOverrides;
  readonly reconciliation: ReconciliationModuleOverrides;
  readonly lates: MoneyLates;
  /** Payments outbox events to checkout; driven by `createPaymentEventsRelay` (see I-2). */
  readonly paymentEvents: PaymentEventsToCheckout;
}

export interface MoneyWiringOptions {
  readonly config: AppConfig;
  readonly pg: PersistenceWiring | undefined;
  /** Commission and tax-category facts. Defaults to the registry that refuses unknown stores. */
  readonly terms?: CommerceTermsPort;
}

/**
 * Composes the wave 4 modules. `pg` present: Postgres stores. Absent: in-memory stores, and
 * outside test mode the explicit development fixtures for ports no module can satisfy yet (risk,
 * age policy, KYC bank details, payout rail, settlement clearing, ETA). Production never receives
 * those: a missing real port is a boot failure inside each module, not a silent fake.
 */
export function composeMoney(o: MoneyWiringOptions): MoneyWiring {
  const lates = createMoneyLates();
  const dev = o.config.adapters === "in-memory-dev";
  const ids = createIdGenerator(systemClock, nodeCsprng);

  // Ledger store: in memory the same instance is the unit of work, read model and snapshots.
  const mem = o.pg === undefined ? new InMemoryLedger() : undefined;
  const ledger: LedgerModuleOverrides =
    o.pg !== undefined
      ? { store: o.pg.money.ledger.store, reads: o.pg.money.ledger.reads, snapshots: o.pg.money.ledger.snapshots }
      : mem === undefined
        ? {}
        : { store: mem as unknown as LedgerStore<LedgerTxn>, reads: mem, snapshots: mem };
  const uow =
    o.pg !== undefined
      ? o.pg.money.ledger.uow
      : { run: <R,>(fn: (tx: LedgerTxn) => Promise<R>): Promise<R> => (mem as InMemoryLedger).run(fn) };
  const gateway = new LedgerGateway({
    posting: lates.posting,
    store: lates.ledgerStore,
    reads: lates.ledgerReads,
    uow,
  });

  const providerPort = new PaymentsModuleProvider({
    create: lates.createIntent,
    voidPayment: lates.voidPayment,
    refundPayment: lates.refundPayment,
  });
  const terms: CommerceTermsPort = o.terms ?? lates.terms;

  const checkoutReal: CheckoutModuleOverrides = {
    cart: new CartAdapter({
      quote: lates.quoteBag,
      catalog: lates.catalog,
      membership: lates.membership,
      repo: lates.cartRepo,
      directory: lates.directory,
      terms,
      nowMs: () => systemClock.nowMs(),
      newId: () => ids.uuidV7(),
    }),
    promotions: new PromotionsAdapter(lates.promotions),
    tax: new TaxAdapter(lates.tax),
    inventory: new InventoryAdapter(lates.reserve, lates.claim, lates.release),
    credit: new StoreCreditAdapter(lates.holds, lates.creditStore),
    payments: new PaymentsRegistry(providerPort),
    ledger: gateway.checkout(),
    orders: new OrdersAdapter(lates.orders),
    ...(o.pg === undefined ? {} : { repository: o.pg.money.checkout.repository }),
  };
  // Ports with no module behind them: development fixtures only, never in production.
  const checkoutDevFixtures: CheckoutModuleOverrides =
    dev && o.config.env !== "test"
      ? {
          risk: new FakeRisk(),
          agePolicy: new FakeAgePolicy(),
          killSwitch: new FakeKillSwitch(),
          addresses: new FakeAddresses(),
          appAttest: new FakeAppAttest(),
          codConfirmation: new FakeCodConfirmation(),
          metrics: new FakeMetrics(),
          lockSecret: randomBytes(32).toString("hex"),
        }
      : {};

  const payoutSource = new FakePayoutSource();
  const payoutBank = new FakeSellerBank();
  const payoutsDev: PayoutsModuleOverrides =
    dev && o.config.env !== "test"
      ? {
          source: payoutSource,
          statementSource: payoutSource,
          bank: payoutBank,
          nameMatch: new FakeIbanNameMatch(payoutBank),
          provider: new FakePayoutPort(),
          risk: new FakePayoutRisk(),
          flags: new FakeFlags(),
        }
      : {};
  const reconDev: ReconciliationModuleOverrides =
    dev && o.config.env !== "test"
      ? {
          eta: new FakeEtaSource(),
          alerts: new FakeReconAlerts(),
          flags: new FakeReconFlags(),
        }
      : {};

  return {
    lates,
    ledger: { ...ledger, projection: new StoreCreditProjection(lates.creditStore) },
    payments: o.pg === undefined ? {} : { store: o.pg.money.payments.store },
    checkout: { ...checkoutDevFixtures, ...checkoutReal },
    refunds: {
      ledger: gateway.refunds(),
      creditRestore: { restore: (i) => lates.restoreCredit.get().restore(i) },
      ...(o.pg === undefined ? {} : { store: o.pg.money.refunds.store }),
    },
    storeCredit: {
      ledger: gateway.credit(),
      // R-6: the sweeper never releases a hold whose checkout saga is not terminal.
      holdLiveness: new SagaHoldLiveness({ get: (id) => lates.sagas.get().get(id) }),
      ...(o.pg === undefined ? {} : { store: o.pg.money.storeCredit.store }),
    },
    payouts: {
      ...payoutsDev,
      ledger: gateway.payouts(),
      approvals: new AdminPayoutApprovals(lates.adminStore),
      ...(o.pg === undefined ? {} : { store: o.pg.money.payouts.store }),
    },
    reconciliation: {
      ...reconDev,
      clearing: new LedgerClearingAdapter(lates.ledgerSnapshots),
      integrity: new LedgerIntegrityPort(lates.ledgerSnapshots, lates.ledgerProjection),
      ...(o.pg === undefined ? {} : { store: o.pg.money.reconciliation.store }),
    },
    paymentEvents: new PaymentEventsToCheckout(lates.checkoutWebhook),
  };
}
