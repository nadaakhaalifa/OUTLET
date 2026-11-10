import { contextClient } from "@outlet/db";
import type { RoleSqlClient } from "@outlet/db";
import { createLogger } from "@outlet/logger";
import type { Logger } from "@outlet/logger";
import { InboxProcessor } from "@outlet/outbox";
import type { InboxOutcome, OutboxEvent } from "@outlet/outbox";
import { z } from "zod";
import type { Channel } from "../domain/types.js";
import { DISPATCH_JOB, Dispatcher } from "./dispatcher.js";
import type { DispatcherDeps } from "./dispatcher.js";
import { NOTIFYING_EVENT_TYPES, mapEvent } from "./event-map.js";

/** What the worker runner hands a handler. */
export interface NotificationEventIn {
  readonly id: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt?: string;
}

const Uuid = z.uuid();
const PayloadUser = z.object({ user_id: Uuid }).loose();
const StoreMembers = z.object({ store_id: Uuid }).loose();
const KNOWN: readonly string[] = NOTIFYING_EVENT_TYPES;

/** The sender side is not composed here: an unconfigured channel has no port, so rows stay `queued` (provider NULL) and are never marked sent. */
const NO_PORTS: Readonly<Record<Channel, readonly never[]>> = { push: [], in_app: [], whatsapp: [], sms: [], email: [] };

/**
 * Inbox consumer of every NOTIFYING_EVENT_TYPE (worker job `notifications.dispatch`, ADR-0011 / ADR-0016). It plans the per-recipient, per-channel
 * notification_log rows inside one inbox transaction (consent, preferences, caps, kill switches and Cairo quiet hours are applied by the Dispatcher).
 * It never sends: with no channel provider contracted (ADR-0029) every outbound row stays `queued` with provider NULL, so nothing claims delivery.
 * A payload without a valid recipient id is parked (inbox row + error log, no loop to the DLQ). Database errors propagate (retry, then DLQ).
 */
export class NotificationDispatchConsumer {
  private readonly dispatcher: Dispatcher;
  private readonly inbox: InboxProcessor;
  private readonly log: Logger;
  constructor(client: RoleSqlClient<"outlet_worker">, private readonly marketId: string, deps: Omit<DispatcherDeps, "db" | "channels">) {
    this.log = deps.logger ?? createLogger();
    this.dispatcher = new Dispatcher({ ...deps, db: client, channels: NO_PORTS, logger: this.log });
    this.inbox = new InboxProcessor(contextClient(client, { kind: "worker", marketId, job: DISPATCH_JOB }));
  }

  async handle(event: NotificationEventIn): Promise<InboxOutcome> {
    const full: OutboxEvent = {
      id: event.id, type: event.type, aggregateType: "notification_source", aggregateId: event.id, marketId: this.marketId,
      occurredAt: event.occurredAt ?? new Date().toISOString(), visibility: "internal", payload: event.payload,
    };
    const reason = this.invalid(full);
    if (reason !== null) return this.park(event, reason);
    const outcome = await this.dispatcher.handle(full);
    return outcome === "duplicate" ? "duplicate" : "processed";
  }

  private invalid(e: OutboxEvent): string | null {
    if (!KNOWN.includes(e.type)) return "unknown_type";
    const n = mapEvent(e);
    if (n === null) return null; // e.g. a seller-initiated cancellation: nothing to notify, acked
    return (n.audience === "payload_user" ? PayloadUser : StoreMembers).safeParse(e.payload).success ? null : "invalid_payload";
  }

  private async park(event: NotificationEventIn, reason: string): Promise<InboxOutcome> {
    const res = await this.inbox.process(DISPATCH_JOB, event.id, () => Promise.resolve());
    if (res === "processed") this.log.error("notifications.dispatch: event parked, no notification planned", { event_id: event.id, type: event.type, reason });
    return res;
  }
}
