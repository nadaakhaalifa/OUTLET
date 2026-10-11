import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import {
  FakeResaleCatalog,
  FakeResaleConsent,
  FakeResaleLedger,
  FakeReturnFacts,
  InMemoryResaleMetrics,
  InMemoryResaleStore,
  StaticResaleFlags,
  StaticResaleTerms,
} from "./adapters/in-memory";
import { ResaleController } from "./adapters/resale.controller";
import { ResaleOperatorResolver, ResaleStoreResolver } from "./adapters/resolvers";
import * as T from "./adapters/tokens";
import { BrowseResale, ListReturnedUnit, RecordResaleSale, WithdrawListing, type ResaleDeps } from "./application/resale";
import type { ResaleCatalogPort, ResaleConsentPort, ResaleFlagsPort, ResaleLedgerPort, ResaleMetrics, ResaleStore, ResaleTermsPort, ReturnFactsPort } from "./domain/ports";

export interface ResaleLaneOptions {
  readonly store?: ResaleStore;
  /** Inspected-return facts from the returns module. */
  readonly returns?: ReturnFactsPort;
  /** Seller opt-in (Seller Agreement settings) and RTV terms. Fails closed. */
  readonly consent?: ResaleConsentPort;
  /** Commission and vendor share, from the commission engine. */
  readonly terms?: ResaleTermsPort;
  readonly catalog?: ResaleCatalogPort;
  /** Backed by `kill.resale_lane`. */
  readonly flags?: ResaleFlagsPort;
  readonly ledger?: ResaleLedgerPort;
  readonly metrics?: ResaleMetrics;
}

export class MissingResalePortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`ResaleLaneModule requires real ${missing.join(", ")} outside test mode`);
    this.name = "MissingResalePortsError";
  }
}

@Module({})
export class ResaleLaneModule {
  static forRoot(config: AppConfig, o: ResaleLaneOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && o.store === undefined) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      const missing: string[] = [];
      if (o.returns === undefined) missing.push("returns (inspected return facts)");
      if (o.consent === undefined) missing.push("consent (seller opt-in, RTV terms)");
      if (o.terms === undefined) missing.push("terms (commission engine)");
      if (o.catalog === undefined) missing.push("catalog (resale SKU creation)");
      if (o.flags === undefined) missing.push("flags (kill.resale_lane)");
      if (o.ledger === undefined) missing.push("ledger (balanced journal posting)");
      if (missing.length > 0) throw new MissingResalePortsError(missing);
    }
    const store = o.store ?? new InMemoryResaleStore();
    const returns = o.returns ?? new FakeReturnFacts();
    const consent = o.consent ?? new FakeResaleConsent();
    const terms = o.terms ?? new StaticResaleTerms();
    const catalog = o.catalog ?? new FakeResaleCatalog();
    const flags = o.flags ?? new StaticResaleFlags(true);
    const ledger = o.ledger ?? new FakeResaleLedger();
    const metrics = o.metrics ?? new InMemoryResaleMetrics();
    const RUNTIME = Symbol("resale.Runtime");
    const runtime = (clock: Clock, ids: IdGenerator) => {
      const d: ResaleDeps = { store, returns, consent, terms, catalog, flags, ledger, metrics, clock, ids };
      return { list: new ListReturnedUnit(d), sale: new RecordResaleSale(d), withdraw: new WithdrawListing(d), browse: new BrowseResale(d) };
    };
    type Runtime = ReturnType<typeof runtime>;
    const from = (token: symbol, pick: (r: Runtime) => unknown) => ({ provide: token, inject: [RUNTIME], useFactory: (r: Runtime) => pick(r) });
    return {
      module: ResaleLaneModule,
      controllers: [ResaleController],
      providers: [
        { provide: T.RESALE_STORE, useValue: store },
        { provide: T.RESALE_RETURNS, useValue: returns },
        { provide: T.RESALE_CONSENT, useValue: consent },
        { provide: T.RESALE_TERMS, useValue: terms },
        { provide: T.RESALE_CATALOG, useValue: catalog },
        { provide: T.RESALE_FLAGS, useValue: flags },
        { provide: T.RESALE_LEDGER, useValue: ledger },
        { provide: T.RESALE_METRICS, useValue: metrics },
        { provide: T.RESALE_OPERATOR_RESOLVER, useValue: new ResaleOperatorResolver() },
        { provide: T.RESALE_STORE_RESOLVER, useValue: new ResaleStoreResolver() },
        { provide: RUNTIME, inject: [CLOCK, ID_GENERATOR], useFactory: (c: Clock, ids: IdGenerator) => runtime(c, ids) },
        from(T.LIST_RETURNED_UNIT, (r) => r.list),
        from(T.RECORD_RESALE_SALE, (r) => r.sale),
        from(T.WITHDRAW_LISTING, (r) => r.withdraw),
        from(T.BROWSE_RESALE, (r) => r.browse),
      ],
      exports: [T.RECORD_RESALE_SALE, T.RESALE_STORE],
    };
  }
}
