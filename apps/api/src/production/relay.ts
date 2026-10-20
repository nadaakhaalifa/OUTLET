import { randomBytes } from "node:crypto";
import { InboxConsumer, OutboxRelay, type OutboxMessage, type Publisher, type RelayConfig } from "@outlet/outbox";
import type { Kysely } from "kysely";
import type { BrandEventConsumerPort } from "../modules/admin";
import { PaymentEventsPublisher } from "../composition/money-wiring";
import { AUTO_BUY_CONSUMED_EVENTS } from "../modules/auto-buy";
import { CREATOR_CONSUMED_EVENTS } from "../modules/creators";
import { ORDER_CONSUMED_EVENTS } from "../modules/orders";
import { SEARCH_SYNC_CONSUMED_EVENTS } from "../modules/search";
import { KyselyInboxStore, KyselyOutboxStore, KyselyTransactionRunner, type DbTx, type PlatformTables } from "../platform/db";
import { createIdGenerator, nodeCsprng, systemClock } from "../platform/system-adapters";
import { instruments } from "../platform/telemetry";
import type { ProductionRuntime } from "./compose";

/**
 * Routes a relayed outbox message to the in-process consumer that owns its event type. Consumers:
 * the checkout saga bridge (`payment.*`) and the brand onboarding consumer (`brand_application.*`:
 * provisioning, auto-checks, applicant notifications), both deduplicated through the inbox. An event
 * type with no consumer yet is ACKNOWLEDGED, counted, and stays in `outbox_events` (published_at
 * set) so a future broker or consumer can replay it by clearing published_at. This is deliberate:
 * leaving unconsumed rows pending would make the lag signal meaningless (ADR-0029).
 */
const AUTO_BUY_TYPES: ReadonlySet<string> = new Set(AUTO_BUY_CONSUMED_EVENTS);
const CREATOR_TYPES: ReadonlySet<string> = new Set(CREATOR_CONSUMED_EVENTS);
const ORDER_TYPES: ReadonlySet<string> = new Set(ORDER_CONSUMED_EVENTS);
const SEARCH_TYPES: ReadonlySet<string> = new Set(SEARCH_SYNC_CONSUMED_EVENTS);

export class RoutingPublisher implements Publisher {
  private readonly unrouted = new Map<string, number>();

  constructor(
    private readonly payments: Publisher,
    private readonly brand: Publisher | null = null,
    private readonly autoBuy: Publisher | null = null,
    private readonly creators: Publisher | null = null,
    private readonly orders: Publisher | null = null,
    private readonly search: Publisher | null = null,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    if (message.eventType.startsWith("payment.")) {
      await this.payments.publish(message);
      return;
    }
    if (this.brand !== null && message.eventType.startsWith("brand_application.")) {
      await this.brand.publish(message);
      return;
    }
    // An event type may have several in-process consumers (order_group.paid: creators attribution
    // and auto-buy CloseOnPurchase). Each has its own inbox consumer name, so a retry after a
    // partial failure re-runs only the consumers that did not commit.
    const targets: Publisher[] = [];
    if (this.autoBuy !== null && AUTO_BUY_TYPES.has(message.eventType)) targets.push(this.autoBuy);
    if (this.creators !== null && CREATOR_TYPES.has(message.eventType)) targets.push(this.creators);
    if (this.orders !== null && ORDER_TYPES.has(message.eventType)) targets.push(this.orders);
    if (this.search !== null && SEARCH_TYPES.has(message.eventType)) targets.push(this.search);
    if (targets.length > 0) {
      for (const t of targets) await t.publish(message);
      return;
    }
    this.unrouted.set(message.eventType, (this.unrouted.get(message.eventType) ?? 0) + 1);
  }

  /** Event type name to count of acknowledged-without-consumer deliveries in this process. */
  unroutedCounts(): ReadonlyMap<string, number> {
    return this.unrouted;
  }
}

/**
 * Delivers `brand_application.*` to the provisioning consumer inside the inbox transaction: the
 * dedupe row and the handler commit or roll back together, so a handler throw retries the message
 * (outbox backoff, DLQ after maxAttempts) and a replay is a no-op.
 */
export class BrandEventsPublisher<Tx> implements Publisher {
  constructor(
    private readonly inbox: InboxConsumer<Tx>,
    private readonly consumer: BrandEventConsumerPort,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.inbox.consume({
      consumer: BRAND_EVENTS_CONSUMER,
      messageId: message.messageId,
      handler: async () => {
        await this.consumer.handle({ messageId: message.messageId, type: message.eventType, payload: message.payload });
      },
    });
  }
}

/** Delivers `price.changed` and `privacy.deletion_completed` to the auto-buy consumer inside the inbox transaction. */
export class AutoBuyEventsPublisher<Tx> implements Publisher {
  constructor(
    private readonly inbox: InboxConsumer<Tx>,
    private readonly consumer: { handle(e: { messageId: string; type: string; payload: unknown }): Promise<unknown> },
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.inbox.consume({
      consumer: AUTO_BUY_EVENTS_CONSUMER,
      messageId: message.messageId,
      handler: async () => {
        await this.consumer.handle({ messageId: message.messageId, type: message.eventType, payload: message.payload });
      },
    });
  }
}

export const AUTO_BUY_EVENTS_CONSUMER = "auto-buy.relay";

/**
 * Delivers order_line.closed / order_line.refunded / order_group.paid to the creators consumer inside
 * the inbox transaction. A throw (including CreatorEventDeferredError for a held attribution)
 * rolls the inbox row back, so the relay retries with backoff and dead-letters after maxAttempts.
 */
export class CreatorEventsPublisher<Tx> implements Publisher {
  constructor(
    private readonly inbox: InboxConsumer<Tx>,
    private readonly consumer: { handle(e: { messageId: string; type: string; payload: unknown; occurredAtMs?: number }): Promise<unknown> },
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.inbox.consume({
      consumer: CREATOR_EVENTS_CONSUMER,
      messageId: message.messageId,
      handler: async () => {
        await this.consumer.handle({
          messageId: message.messageId,
          type: message.eventType,
          payload: message.payload,
          occurredAtMs: message.occurredAt.getTime(),
        });
      },
    });
  }
}

export const CREATOR_EVENTS_CONSUMER = "creators.relay";

/** Delivers `shipment.delivered` to the orders delivery consumer inside the inbox transaction. */
export class OrderEventsPublisher<Tx> implements Publisher {
  constructor(
    private readonly inbox: InboxConsumer<Tx>,
    private readonly consumer: { handle(e: { messageId: string; type: string; payload: unknown; occurredAtMs?: number }): Promise<unknown> },
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.inbox.consume({
      consumer: ORDER_EVENTS_CONSUMER,
      messageId: message.messageId,
      handler: async () => {
        await this.consumer.handle({
          messageId: message.messageId,
          type: message.eventType,
          payload: message.payload,
          occurredAtMs: message.occurredAt.getTime(),
        });
      },
    });
  }
}

export const ORDER_EVENTS_CONSUMER = "orders.relay";

/**
 * Delivers catalog product events to the search index feeder inside the inbox transaction (A2.7): message_id is
 * recorded in inbox_processed with the handler, a duplicate is a no-op, and a throw (catalog read behind the
 * event) rolls the row back so the relay retries with backoff and dead-letters after maxAttempts.
 */
export class SearchEventsPublisher<Tx> implements Publisher {
  constructor(
    private readonly inbox: InboxConsumer<Tx>,
    private readonly consumer: { handle(e: { messageId: string; type: string; payload: unknown; occurredAtMs?: number }): Promise<unknown> },
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.inbox.consume({
      consumer: SEARCH_EVENTS_CONSUMER,
      messageId: message.messageId,
      handler: async () => {
        await this.consumer.handle({
          messageId: message.messageId,
          type: message.eventType,
          payload: message.payload,
          occurredAtMs: message.occurredAt.getTime(),
        });
      },
    });
  }
}

export const SEARCH_EVENTS_CONSUMER = "search.sync.relay";

/** Inbox consumer name for the relay-level dedupe (distinct from the use case's own name). */
export const BRAND_EVENTS_CONSUMER = "brand-onboarding.relay";

export interface RelayExtras {
  /** Resolved from the booted graph (BRAND_EVENT_CONSUMER). Absent or null: brand events are acknowledged unrouted. */
  readonly brandEvents?: BrandEventConsumerPort | null;
  /** Resolved from the booted graph (AUTO_BUY_EVENT_CONSUMER). Absent: those events are acknowledged unrouted. */
  readonly autoBuyEvents?: { handle(e: { messageId: string; type: string; payload: unknown }): Promise<unknown> } | null;
  /** Resolved from the booted graph (CREATOR_EVENT_CONSUMER). Absent or null (module not composed): acknowledged unrouted. */
  /** Resolved from the booted graph (ORDER_DELIVERY_CONSUMER). Absent: `shipment.delivered` is acknowledged unrouted. */
  readonly orderEvents?: { handle(e: { messageId: string; type: string; payload: unknown; occurredAtMs?: number }): Promise<unknown> } | null;
  /** Resolved from the booted graph (SEARCH_SYNC_EVENT_CONSUMER). Absent or null: catalog product events are acknowledged unrouted. */
  readonly searchEvents?: { handle(e: { messageId: string; type: string; payload: unknown; occurredAtMs?: number }): Promise<unknown> } | null;
  readonly creatorEvents?: { handle(e: { messageId: string; type: string; payload: unknown; occurredAtMs?: number }): Promise<unknown> } | null;
}

export interface RelayHandle {
  runOnce(): Promise<object>;
  readonly publisher: RoutingPublisher;
}

const RELAY_CONFIG: RelayConfig = { batchSize: 100, maxAttempts: 8, backoff: { baseMs: 500, capMs: 60_000 } };

/** The production outbox relay: Postgres outbox, inbox-deduped payment consumer, DLQ after 8 attempts. */
export function createProductionRelay(runtime: ProductionRuntime, extras: RelayExtras = {}): RelayHandle {
  const platformDb = runtime.db as unknown as Kysely<PlatformTables>;
  const ids = createIdGenerator(systemClock, nodeCsprng);
  const store = new KyselyOutboxStore(platformDb);
  const runner = new KyselyTransactionRunner<PlatformTables>({ db: platformDb, outbox: store, clock: systemClock, ids });
  const uow = runner.unitOfWork({ session: { userId: null, role: "system" }, process: "outbox.consume", profile: "default" });
  const clock = { now: (): Date => new Date(systemClock.nowMs()) };
  const inbox = new InboxConsumer<DbTx<PlatformTables>>({ uow, inbox: new KyselyInboxStore(), clock });
  const brand = extras.brandEvents === undefined || extras.brandEvents === null ? null : new BrandEventsPublisher(inbox, extras.brandEvents);
  const autoBuy = extras.autoBuyEvents === undefined || extras.autoBuyEvents === null ? null : new AutoBuyEventsPublisher(inbox, extras.autoBuyEvents);
  const creators = extras.creatorEvents === undefined || extras.creatorEvents === null ? null : new CreatorEventsPublisher(inbox, extras.creatorEvents);
  const orders = extras.orderEvents === undefined || extras.orderEvents === null ? null : new OrderEventsPublisher(inbox, extras.orderEvents);
  const search = extras.searchEvents === undefined || extras.searchEvents === null ? null : new SearchEventsPublisher(inbox, extras.searchEvents);
  const publisher = new RoutingPublisher(new PaymentEventsPublisher(inbox, runtime.paymentEvents), brand, autoBuy, creators, orders, search);
  const relay = new OutboxRelay<DbTx<PlatformTables>>(
    { store, publisher, clock, random: () => nodeRandom() },
    RELAY_CONFIG,
  );
  return {
    runOnce: async () => {
      const report = await relay.runOnce();
      await publishDeadLetterGauge(store);
      return report;
    },
    publisher,
  };
}

function nodeRandom(): number {
  return randomBytes(4).readUInt32BE(0) / 0x1_0000_0000;
}

/**
 * Publishes the dead-lettered outbox events by type (gauge, so it falls back to 0 once an operator
 * replays them). A deferred creator accrual or attribution that exhausts the relay's attempts lands here
 * (docs/runbooks/creators-accrual-dlq.md). Telemetry failures never fail the relay run.
 */
export async function publishDeadLetterGauge(store: { listDeadLettered(limit: number): Promise<readonly { readonly eventType: string }[]> }): Promise<void> {
  try {
    const dead = await store.listDeadLettered(500);
    const counts = new Map<string, number>();
    for (const r of dead) counts.set(r.eventType, (counts.get(r.eventType) ?? 0) + 1);
    const i = instruments();
    // Always set the creators-relevant types so the gauge returns to 0 after a replay.
    for (const t of ["order_line.closed", "order_group.paid", "order_group.cod_confirmed", "order_line.refunded"]) {
      if (!counts.has(t)) counts.set(t, 0);
    }
    for (const [event_type, n] of counts) i.setGauge("outlet.outbox.dead_lettered", n, { event_type });
  } catch {
    // best effort
  }
}
