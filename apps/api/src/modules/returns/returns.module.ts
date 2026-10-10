import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import {
  AutoApproveOverdueInspections,
  CloseElapsedDisputeWindows,
  CompleteReturnExchange,
  CompleteReturnRefund,
  DisputeReturn,
  GetMyReturn,
  InspectReturn,
  ListMyReturns,
  ListSellerReturns,
  PublishPendingIntents,
  RecordReturnPickedUp,
  RecordReturnPickupFailed,
  RecordReturnReceived,
  RequestReturn,
  ResolveReturnDispute,
  ScheduleReturnPickup,
  type ReturnsDeps,
} from "./application/returns";
import {
  FakeEvidence,
  FakeExchangeStock,
  FakeReturnableLines,
  InMemoryReturnEventPublisher,
  InMemoryReturnRepository,
  StaticReturnerHistory,
  StaticReturnsMembership,
} from "./adapters/in-memory";
import { OrderLineResolver, OwnReturnResolver, StoreListResolver, StoreReturnResolver } from "./adapters/resolvers";
import { ReturnsController } from "./adapters/returns.controller";
import * as T from "./adapters/tokens";
import type {
  EvidencePort,
  ExchangeStockPort,
  MembershipPort,
  ReturnEventPublisher,
  ReturnRepository,
  ReturnableLinePort,
  ReturnerHistoryPort,
} from "./domain/ports";

export interface ReturnsModuleOverrides {
  readonly repository?: ReturnRepository;
  readonly lines?: ReturnableLinePort;
  readonly membership?: MembershipPort;
  readonly history?: ReturnerHistoryPort;
  readonly evidence?: EvidencePort;
  readonly exchangeStock?: ExchangeStockPort;
  readonly events?: ReturnEventPublisher;
}

/**
 * Thrown at boot outside test mode when a port owned by another module is missing. Returns must
 * never decide eligibility from an empty fixture order book, a "nobody is Plus" default or an
 * evidence check that accepts anything.
 */
export class MissingReturnsPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`ReturnsModule requires real ${missing.join(", ")} outside test mode: supply them through ReturnsModule.forRoot(config, overrides)`);
    this.name = "MissingReturnsPortsError";
  }
}

@Module({})
export class ReturnsModule {
  static forRoot(config: AppConfig, overrides: ReturnsModuleOverrides = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && overrides.repository === undefined) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      const missing: string[] = [];
      if (overrides.lines === undefined) missing.push("lines (RETURNS_LINES: delivered order lines)");
      if (overrides.membership === undefined) missing.push("membership (RETURNS_MEMBERSHIP)");
      if (overrides.history === undefined) missing.push("history (RETURNS_HISTORY)");
      if (overrides.evidence === undefined) missing.push("evidence (RETURNS_EVIDENCE)");
      if (overrides.exchangeStock === undefined) missing.push("exchangeStock (RETURNS_EXCHANGE_STOCK)");
      if (overrides.events === undefined) missing.push("events (RETURNS_EVENTS: outbox publisher)");
      if (missing.length > 0) throw new MissingReturnsPortsError(missing);
    }
    const repo = overrides.repository ?? new InMemoryReturnRepository();
    const lines = overrides.lines ?? new FakeReturnableLines();
    const inject = [
      T.RETURNS_REPOSITORY,
      T.RETURNS_LINES,
      T.RETURNS_MEMBERSHIP,
      T.RETURNS_HISTORY,
      T.RETURNS_EVIDENCE,
      T.RETURNS_EXCHANGE_STOCK,
      T.RETURNS_EVENTS,
      CLOCK,
      ID_GENERATOR,
    ];
    const build = (
      r: ReturnRepository,
      l: ReturnableLinePort,
      m: MembershipPort,
      h: ReturnerHistoryPort,
      ev: EvidencePort,
      ex: ExchangeStockPort,
      events: ReturnEventPublisher,
      clock: Clock,
      ids: IdGenerator,
    ): ReturnsDeps => ({ repo: r, lines: l, membership: m, history: h, evidence: ev, exchangeStock: ex, events, clock, ids });
    const useCase = <X>(token: symbol, make: (d: ReturnsDeps) => X) => ({
      provide: token,
      inject,
      useFactory: (...a: Parameters<typeof build>): X => make(build(...a)),
    });
    return {
      module: ReturnsModule,
      controllers: [ReturnsController],
      providers: [
        { provide: T.RETURNS_REPOSITORY, useValue: repo },
        { provide: T.RETURNS_LINES, useValue: lines },
        { provide: T.RETURNS_MEMBERSHIP, useValue: overrides.membership ?? new StaticReturnsMembership() },
        { provide: T.RETURNS_HISTORY, useValue: overrides.history ?? new StaticReturnerHistory() },
        { provide: T.RETURNS_EVIDENCE, useValue: overrides.evidence ?? new FakeEvidence() },
        { provide: T.RETURNS_EXCHANGE_STOCK, useValue: overrides.exchangeStock ?? new FakeExchangeStock() },
        { provide: T.RETURNS_EVENTS, useValue: overrides.events ?? new InMemoryReturnEventPublisher() },
        { provide: T.RETURNS_LINE_RESOLVER, useValue: new OrderLineResolver(lines) },
        { provide: T.RETURNS_OWN_RESOLVER, useValue: new OwnReturnResolver(repo) },
        { provide: T.RETURNS_STORE_RETURN_RESOLVER, useValue: new StoreReturnResolver(repo) },
        { provide: T.RETURNS_STORE_LIST_RESOLVER, useValue: new StoreListResolver() },
        useCase(T.REQUEST_RETURN, (d) => new RequestReturn(d)),
        useCase(T.INSPECT_RETURN, (d) => new InspectReturn(d)),
        useCase(T.DISPUTE_RETURN, (d) => new DisputeReturn(d)),
        useCase(T.LIST_MY_RETURNS, (d) => new ListMyReturns(d)),
        useCase(T.GET_MY_RETURN, (d) => new GetMyReturn(d)),
        useCase(T.LIST_SELLER_RETURNS, (d) => new ListSellerReturns(d)),
        useCase(T.SCHEDULE_RETURN_PICKUP, (d) => new ScheduleReturnPickup(d)),
        useCase(T.RECORD_RETURN_PICKED_UP, (d) => new RecordReturnPickedUp(d)),
        useCase(T.RECORD_RETURN_PICKUP_FAILED, (d) => new RecordReturnPickupFailed(d)),
        useCase(T.RECORD_RETURN_RECEIVED, (d) => new RecordReturnReceived(d)),
        useCase(T.AUTO_APPROVE_OVERDUE, (d) => new AutoApproveOverdueInspections(d)),
        useCase(T.CLOSE_ELAPSED_DISPUTES, (d) => new CloseElapsedDisputeWindows(d)),
        useCase(T.RESOLVE_RETURN_DISPUTE, (d) => new ResolveReturnDispute(d)),
        useCase(T.COMPLETE_RETURN_REFUND, (d) => new CompleteReturnRefund(d)),
        useCase(T.COMPLETE_RETURN_EXCHANGE, (d) => new CompleteReturnExchange(d)),
        useCase(T.PUBLISH_PENDING_INTENTS, (d) => new PublishPendingIntents(d)),
      ],
      exports: [
        T.RETURNS_REPOSITORY,
        T.RETURNS_EVENTS,
        T.SCHEDULE_RETURN_PICKUP,
        T.RECORD_RETURN_PICKED_UP,
        T.RECORD_RETURN_PICKUP_FAILED,
        T.RECORD_RETURN_RECEIVED,
        T.AUTO_APPROVE_OVERDUE,
        T.CLOSE_ELAPSED_DISPUTES,
        T.RESOLVE_RETURN_DISPUTE,
        T.COMPLETE_RETURN_REFUND,
        T.COMPLETE_RETURN_EXCHANGE,
        T.PUBLISH_PENDING_INTENTS,
      ],
    };
  }
}
