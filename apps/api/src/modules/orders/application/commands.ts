import type { Clock, IdGenerator } from "../../../platform/ports";
import {
  AcceptWindowElapsedError,
  InvalidTransitionError,
  NotCancellableError,
  decideAccept,
  decideAcceptSlaExpiry,
  decideCancel,
  decidePack,
  decideReject,
  decideShip,
  refundRequired,
  rollupOrderGroup,
  type CancelInitiator,
  type RejectReason,
  type Transition,
} from "../domain/bridge";
import type {
  EventPayload,
  OrderRepository,
  OrderScope,
  OutboxEventDraft,
  SellerOrderRecord,
  TransitionCommand,
} from "../domain/ports";

export interface OrderDeps {
  readonly repo: OrderRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export type CommandResult =
  | { readonly kind: "ok"; readonly order: SellerOrderRecord; readonly replayed: boolean }
  | { readonly kind: "not_found" }
  | { readonly kind: "conflict" }
  | { readonly kind: "invalid_transition"; readonly from: string }
  | { readonly kind: "accept_window_elapsed" }
  | { readonly kind: "not_cancellable" };

interface CommandSpec {
  readonly sellerOrderId: string;
  readonly scope: OrderScope;
  /** Already prefixed with the command kind, for example `accept:<Idempotency-Key>`. */
  readonly commandKey: string;
  readonly actorId: string | null;
  readonly decide: (o: SellerOrderRecord, nowMs: number) => Transition | null;
}

const MAX_ATTEMPTS = 2;

/** Facts the domain decisions read; kept explicit so no storage field leaks into the pure layer. */
const factsOf = (o: SellerOrderRecord) => ({
  status: o.status,
  paymentType: o.paymentType,
  acceptByMs: o.acceptByMs,
});

function eventsFor(ids: IdGenerator, o: SellerOrderRecord, t: Transition, nowMs: number): OutboxEventDraft[] {
  const base: Record<string, string | number | boolean | null> = {
    seller_order_id: o.id,
    order_group_id: o.orderGroupId,
    store_id: o.storeId,
    from_status: t.from,
    to_status: t.to,
    occurred_at_ms: nowMs,
  };
  const make = (type: string, extra: EventPayload = {}): OutboxEventDraft => ({
    id: ids.uuidV7(),
    type,
    aggregateType: "seller_order",
    aggregateId: o.id,
    occurredAtMs: nowMs,
    payload: { ...base, ...extra },
  });
  switch (t.event) {
    case "SELLER_ACCEPT":
      return [make("seller_order.accepted", { dispatch_by_ms: t.stamps.dispatchByMs ?? null })];
    case "PACK":
      return [make("seller_order.packed")];
    case "SHIP":
      return [make("seller_order.shipped")];
    case "SELLER_REJECT":
      // Informs the refund saga (F-1). This module never moves money.
      return [
        make("seller_order.rejected", {
          reason: t.rejectReason ?? null,
          payment_type: o.paymentType,
          refund_required: refundRequired(factsOf(o)),
        }),
      ];
    case "CANCEL": {
      const cancelled = make("seller_order.cancelled", {
        initiator: t.cancelInitiator ?? null,
        reason: t.reasonCode,
        payment_type: o.paymentType,
        refund_required: refundRequired(factsOf(o)),
      });
      return t.cancelInitiator === "SYSTEM_TIMEOUT"
        ? [make("seller_order.accept_sla_expired", { accept_by_ms: o.acceptByMs }), cancelled]
        : [cancelled];
    }
    default:
      return [];
  }
}

/** Application service for every seller order command. One code path, so replay, CAS and outbox are uniform. */
export class OrderCommands {
  constructor(private readonly d: OrderDeps) {}

  private async run(spec: CommandSpec): Promise<CommandResult | { readonly kind: "skipped" }> {
    const { repo, clock, ids } = this.d;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const order = await repo.getSellerOrder(spec.sellerOrderId, spec.scope);
      if (order === null) return { kind: "not_found" };
      // Replay first: a repeated command must return the stored outcome, not a new decision.
      if (await repo.hasCommand(spec.sellerOrderId, spec.commandKey)) {
        return { kind: "ok", order, replayed: true };
      }
      const nowMs = clock.nowMs();
      let transition: Transition | null;
      try {
        transition = spec.decide(order, nowMs);
      } catch (e) {
        if (e instanceof AcceptWindowElapsedError) return { kind: "accept_window_elapsed" };
        if (e instanceof NotCancellableError) return { kind: "not_cancellable" };
        if (e instanceof InvalidTransitionError) return { kind: "invalid_transition", from: order.status };
        throw e;
      }
      if (transition === null) return { kind: "skipped" };
      const t = transition;
      const cmd: TransitionCommand = {
        sellerOrderId: spec.sellerOrderId,
        scope: spec.scope,
        expectedVersion: order.version,
        commandKey: spec.commandKey,
        transition: t,
        actorId: spec.actorId,
        nowMs,
        historyId: ids.uuidV7(),
        events: eventsFor(ids, order, t, nowMs),
        rollup: (group, siblings) => {
          const r = rollupOrderGroup(group.status, siblings);
          if (r === null) return null;
          const type = r.to === "CANCELLED" ? "order_group.cancelled" : "order_group.fulfilling";
          return {
            rollup: r,
            events: [
              {
                id: ids.uuidV7(),
                type,
                aggregateType: "order_group",
                aggregateId: group.id,
                occurredAtMs: nowMs,
                payload: { order_group_id: group.id, from_status: group.status, to_status: r.to, occurred_at_ms: nowMs },
              },
            ],
          };
        },
      };
      const res = await repo.applyTransition(cmd);
      switch (res.kind) {
        case "applied":
          return { kind: "ok", order: res.order, replayed: false };
        case "replayed":
          return { kind: "ok", order: res.order, replayed: true };
        case "not_found":
          return { kind: "not_found" };
        case "conflict":
          break; // re-read and decide again
      }
    }
    return { kind: "conflict" };
  }

  private async exec(spec: CommandSpec): Promise<CommandResult> {
    const r = await this.run(spec);
    // Only the SLA sweep returns "skipped"; a user command never does.
    return r.kind === "skipped" ? { kind: "conflict" } : r;
  }

  accept(a: { sellerOrderId: string; scope: OrderScope; actorId: string; idempotencyKey: string }): Promise<CommandResult> {
    return this.exec({
      sellerOrderId: a.sellerOrderId,
      scope: a.scope,
      actorId: a.actorId,
      commandKey: `accept:${a.idempotencyKey}`,
      decide: (o, now) => decideAccept(factsOf(o), now),
    });
  }

  pack(a: { sellerOrderId: string; scope: OrderScope; actorId: string; idempotencyKey: string }): Promise<CommandResult> {
    return this.exec({
      sellerOrderId: a.sellerOrderId,
      scope: a.scope,
      actorId: a.actorId,
      commandKey: `pack:${a.idempotencyKey}`,
      decide: (o, now) => decidePack(factsOf(o), now),
    });
  }

  reject(a: {
    sellerOrderId: string;
    scope: OrderScope;
    actorId: string;
    idempotencyKey: string;
    reason: RejectReason;
  }): Promise<CommandResult> {
    return this.exec({
      sellerOrderId: a.sellerOrderId,
      scope: a.scope,
      actorId: a.actorId,
      commandKey: `reject:${a.idempotencyKey}`,
      decide: (o, now) => decideReject(factsOf(o), a.reason, now),
    });
  }

  /** Fulfilment-driven (no seller route). System scope; the key is the shipment event id. */
  markShipped(a: { sellerOrderId: string; commandKey: string }): Promise<CommandResult> {
    return this.exec({
      sellerOrderId: a.sellerOrderId,
      scope: { kind: "system" },
      actorId: null,
      commandKey: `ship:${a.commandKey}`,
      decide: (o, now) => decideShip(factsOf(o), now),
    });
  }

  cancelByShopper(a: {
    sellerOrderId: string;
    userId: string;
    idempotencyKey: string;
    reason: string;
  }): Promise<CommandResult> {
    return this.cancel(a.sellerOrderId, { kind: "shopper", userId: a.userId }, a.userId, `cancel:${a.idempotencyKey}`, "SHOPPER", a.reason);
  }

  /** Admin or risk cancellation (cancellation saga, later wave). */
  cancelBySystem(a: { sellerOrderId: string; commandKey: string; initiator: Exclude<CancelInitiator, "SHOPPER">; reason: string }) {
    return this.cancel(a.sellerOrderId, { kind: "system" }, null, `cancel:${a.commandKey}`, a.initiator, a.reason);
  }

  private cancel(
    sellerOrderId: string,
    scope: OrderScope,
    actorId: string | null,
    commandKey: string,
    initiator: CancelInitiator,
    reason: string,
  ): Promise<CommandResult> {
    return this.exec({
      sellerOrderId,
      scope,
      actorId,
      commandKey,
      decide: (o, now) => decideCancel(factsOf(o), initiator, reason, now),
    });
  }

  /**
   * Auto-cancel of unaccepted orders past `accept_by`. Idempotent (`sla:<id>` keys) and safe to run
   * concurrently: a lost race re-reads and sees an accepted or cancelled order. A failing order does
   * not stop the batch.
   */
  async expireUnaccepted(limit = 100): Promise<{ cancelled: number; skipped: number; failed: number }> {
    const nowMs = this.d.clock.nowMs();
    const ids = await this.d.repo.findAcceptSlaExpired(nowMs, limit);
    let cancelled = 0;
    let skipped = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        const r = await this.run({
          sellerOrderId: id,
          scope: { kind: "system" },
          actorId: null,
          commandKey: `sla:${id}`,
          decide: (o, now) => decideAcceptSlaExpiry(factsOf(o), now),
        });
        if (r.kind === "ok" && !r.replayed) cancelled += 1;
        else skipped += 1;
      } catch {
        failed += 1;
      }
    }
    return { cancelled, skipped, failed };
  }
}
