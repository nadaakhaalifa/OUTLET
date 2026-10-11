import { randomBytes } from "node:crypto";
import { InboxConsumer, OutboxRelay, type OutboxMessage, type Publisher, type RelayConfig } from "@outlet/outbox";
import type { Kysely } from "kysely";
import { PaymentEventsPublisher } from "../composition/money-wiring";
import { KyselyInboxStore, KyselyOutboxStore, KyselyTransactionRunner, type DbTx, type PlatformTables } from "../platform/db";
import { createIdGenerator, nodeCsprng, systemClock } from "../platform/system-adapters";
import type { ProductionRuntime } from "./compose";

/**
 * Routes a relayed outbox message to the in-process consumer that owns its event type. Today the
 * only consumer is the checkout saga bridge (`payment.*`), deduplicated through the inbox. An event
 * type with no consumer yet is ACKNOWLEDGED, counted, and stays in `outbox_events` (published_at
 * set) so a future broker or consumer can replay it by clearing published_at. This is deliberate:
 * leaving unconsumed rows pending would make the lag signal meaningless (ADR-0029).
 */
export class RoutingPublisher implements Publisher {
  private readonly unrouted = new Map<string, number>();

  constructor(private readonly payments: Publisher) {}

  async publish(message: OutboxMessage): Promise<void> {
    if (message.eventType.startsWith("payment.")) {
      await this.payments.publish(message);
      return;
    }
    this.unrouted.set(message.eventType, (this.unrouted.get(message.eventType) ?? 0) + 1);
  }

  /** Event type name to count of acknowledged-without-consumer deliveries in this process. */
  unroutedCounts(): ReadonlyMap<string, number> {
    return this.unrouted;
  }
}

export interface RelayHandle {
  runOnce(): Promise<object>;
  readonly publisher: RoutingPublisher;
}

const RELAY_CONFIG: RelayConfig = { batchSize: 100, maxAttempts: 8, backoff: { baseMs: 500, capMs: 60_000 } };

/** The production outbox relay: Postgres outbox, inbox-deduped payment consumer, DLQ after 8 attempts. */
export function createProductionRelay(runtime: ProductionRuntime): RelayHandle {
  const platformDb = runtime.db as unknown as Kysely<PlatformTables>;
  const ids = createIdGenerator(systemClock, nodeCsprng);
  const store = new KyselyOutboxStore(platformDb);
  const runner = new KyselyTransactionRunner<PlatformTables>({ db: platformDb, outbox: store, clock: systemClock, ids });
  const uow = runner.unitOfWork({ session: { userId: null, role: "system" }, process: "outbox.consume", profile: "default" });
  const clock = { now: (): Date => new Date(systemClock.nowMs()) };
  const inbox = new InboxConsumer<DbTx<PlatformTables>>({ uow, inbox: new KyselyInboxStore(), clock });
  const publisher = new RoutingPublisher(new PaymentEventsPublisher(inbox, runtime.paymentEvents));
  const relay = new OutboxRelay<DbTx<PlatformTables>>(
    { store, publisher, clock, random: () => nodeRandom() },
    RELAY_CONFIG,
  );
  return { runOnce: () => relay.runOnce(), publisher };
}

function nodeRandom(): number {
  return randomBytes(4).readUInt32BE(0) / 0x1_0000_0000;
}
