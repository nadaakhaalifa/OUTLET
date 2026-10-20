import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import {
  ChangeExemption,
  GetAdminDocument,
  GetSellerInvoice,
  IssueDocument,
  ListAdminDocuments,
  ListExemptionAudit,
  ListSellerInvoices,
  ListTaxCategories,
  PollSubmissionStatuses,
  ProcessSubmissionQueue,
  QuoteOrderTax,
  RequeueDeadLetter,
  RunDailyReconciliation,
  type Clock,
  type Ids,
  type TaxEtaDeps,
} from "./application/tax";
import {
  FakeEtaPort,
  InMemorySignedDocumentStore,
  InMemorySigningDelegations,
  InMemoryTaxConfigRepository,
  InMemoryTaxDocumentRepository,
  InMemoryTaxEtaEventPublisher,
} from "./adapters/in-memory";
import { StoreInvoiceResolver, StoreListResolver } from "./adapters/resolvers";
import { TaxEtaController } from "./adapters/tax-eta.controller";
import * as T from "./adapters/tokens";
import type {
  EtaPort,
  SignedDocumentStore,
  SigningDelegationPort,
  TaxConfigRepository,
  TaxDocumentRepository,
  TaxEtaEventPublisher,
} from "./domain/ports";

export interface TaxEtaModuleOverrides {
  readonly config?: TaxConfigRepository;
  readonly documents?: TaxDocumentRepository;
  readonly eta?: EtaPort;
  readonly signed?: SignedDocumentStore;
  readonly delegations?: SigningDelegationPort;
  readonly events?: TaxEtaEventPublisher;
  /** release.admin.finance_views. Absent means BLOCKED: the from/to range form of GET /v1/admin/tax/reconciliation answers 404. */
  readonly financeViewsEnabled?: () => Promise<boolean> | boolean;
}

/**
 * Thrown at boot outside test mode when a port that must be real is missing. The fake ETA must
 * never be wired into a production process: documents would be "accepted" by nobody.
 */
export class MissingTaxEtaPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`TaxEtaModule requires real ${missing.join(", ")} outside test mode: supply them through TaxEtaModule.forRoot(config, overrides)`);
    this.name = "MissingTaxEtaPortsError";
  }
}

@Module({})
export class TaxEtaModule {
  static forRoot(config: AppConfig, overrides: TaxEtaModuleOverrides = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && (overrides.config === undefined || overrides.documents === undefined)) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      const missing: string[] = [];
      if (overrides.eta === undefined) missing.push("eta (TAX_ETA_PORT: ETA portal adapter)");
      if (overrides.signed === undefined) missing.push("signed (TAX_SIGNED_STORE)");
      if (overrides.events === undefined) missing.push("events (TAX_EVENTS: outbox publisher)");
      if (overrides.delegations === undefined) missing.push("delegations (TAX_DELEGATIONS)");
      if (missing.length > 0) throw new MissingTaxEtaPortsError(missing);
    }
    const documents = overrides.documents ?? new InMemoryTaxDocumentRepository();
    const inject = [T.TAX_CONFIG, T.TAX_DOCUMENTS, T.TAX_ETA_PORT, T.TAX_SIGNED_STORE, T.TAX_DELEGATIONS, T.TAX_EVENTS, CLOCK, ID_GENERATOR];
    const build = (
      cfg: TaxConfigRepository,
      docs: TaxDocumentRepository,
      eta: EtaPort,
      signed: SignedDocumentStore,
      delegations: SigningDelegationPort,
      events: TaxEtaEventPublisher,
      clock: Clock,
      ids: Ids,
    ): TaxEtaDeps => ({ config: cfg, documents: docs, eta, signed, delegations, events, clock, ids });
    const useCase = <X>(token: symbol, make: (d: TaxEtaDeps) => X) => ({
      provide: token,
      inject,
      useFactory: (...a: Parameters<typeof build>): X => make(build(...a)),
    });
    return {
      module: TaxEtaModule,
      controllers: [TaxEtaController],
      providers: [
        { provide: T.TAX_CONFIG, useValue: overrides.config ?? new InMemoryTaxConfigRepository() },
        { provide: T.TAX_DOCUMENTS, useValue: documents },
        { provide: T.TAX_ETA_PORT, useValue: overrides.eta ?? new FakeEtaPort() },
        { provide: T.TAX_SIGNED_STORE, useValue: overrides.signed ?? new InMemorySignedDocumentStore() },
        { provide: T.TAX_DELEGATIONS, useValue: overrides.delegations ?? new InMemorySigningDelegations() },
        { provide: T.TAX_EVENTS, useValue: overrides.events ?? new InMemoryTaxEtaEventPublisher() },
        { provide: T.TAX_FINANCE_VIEWS_ENABLED, useValue: overrides.financeViewsEnabled ?? (() => false) },
        { provide: T.TAX_STORE_LIST_RESOLVER, useValue: new StoreListResolver() },
        { provide: T.TAX_STORE_INVOICE_RESOLVER, useValue: new StoreInvoiceResolver(documents) },
        useCase(T.QUOTE_ORDER_TAX, (d) => new QuoteOrderTax(d)),
        useCase(T.ISSUE_DOCUMENT, (d) => new IssueDocument(d)),
        useCase(T.PROCESS_SUBMISSION_QUEUE, (d) => new ProcessSubmissionQueue(d)),
        useCase(T.POLL_SUBMISSION_STATUSES, (d) => new PollSubmissionStatuses(d)),
        useCase(T.RUN_DAILY_RECONCILIATION, (d) => new RunDailyReconciliation(d)),
        useCase(T.CHANGE_EXEMPTION, (d) => new ChangeExemption(d)),
        useCase(T.REQUEUE_DEAD_LETTER, (d) => new RequeueDeadLetter(d)),
        useCase(T.LIST_TAX_CATEGORIES, (d) => new ListTaxCategories(d)),
        useCase(T.LIST_EXEMPTION_AUDIT, (d) => new ListExemptionAudit(d)),
        useCase(T.LIST_ADMIN_DOCUMENTS, (d) => new ListAdminDocuments(d)),
        useCase(T.GET_ADMIN_DOCUMENT, (d) => new GetAdminDocument(d)),
        useCase(T.LIST_SELLER_INVOICES, (d) => new ListSellerInvoices(d)),
        useCase(T.GET_SELLER_INVOICE, (d) => new GetSellerInvoice(d)),
      ],
      exports: [
        T.QUOTE_ORDER_TAX,
        T.ISSUE_DOCUMENT,
        T.PROCESS_SUBMISSION_QUEUE,
        T.POLL_SUBMISSION_STATUSES,
        T.RUN_DAILY_RECONCILIATION,
        T.TAX_DOCUMENTS,
        T.TAX_EVENTS,
      ],
    };
  }
}
