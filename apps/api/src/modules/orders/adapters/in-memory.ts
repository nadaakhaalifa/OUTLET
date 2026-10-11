/**
 * DEVELOPMENT/TEST FIXTURES: per-process repository that mirrors the Postgres adapter's behaviour
 * (scope filtering, optimistic version, command-key replay, same-"transaction" outbox and group
 * roll-up) so the shared contract suite runs against both. The module refuses to boot with real
 * adapters configured and no repository.
 */
import type { Clock } from "../../../platform/ports";
import type { OrderGroupState } from "../domain/bridge";
import type {
  ApplyResult,
  ListPage,
  GroupPage,
  ListGroupsQuery,
  ListQuery,
  NewOrderGroup,
  OrderGroupRecord,
  OrderRepository,
  OrderScope,
  OutboxEventDraft,
  SellerOrderRecord,
  StoreLookupPort,
  StoreSummaryFacts,
  TransitionCommand,
} from "../domain/ports";

interface Entry {
  order: SellerOrderRecord;
  commands: Set<string>;
}
interface GroupRow {
  base: Omit<OrderGroupRecord, "sellerOrders">;
  idempotencyKey: string;
  orderIds: string[];
}

export interface HistoryRow {
  readonly id: string;
  readonly sellerOrderId: string;
  readonly from: string;
  readonly to: string;
  readonly event: string;
  readonly commandKey: string;
  readonly reasonCode: string | null;
}

const visible = (o: SellerOrderRecord, scope: OrderScope): boolean =>
  scope.kind === "system" ||
  (scope.kind === "seller" && scope.storeIds.includes(o.storeId)) ||
  (scope.kind === "shopper" && scope.userId === o.userId);

/** Buyer contact is only readable by tenant staff and the system (same as the RLS policy). */
const forScope = (o: SellerOrderRecord, scope: OrderScope): SellerOrderRecord =>
  scope.kind === "shopper" ? { ...o, buyer: null } : o;

export class InMemoryOrderRepository implements OrderRepository {
  private readonly orders = new Map<string, Entry>();
  private readonly groups = new Map<string, GroupRow>();
  private readonly byKey = new Map<string, string>();
  readonly outbox: OutboxEventDraft[] = [];
  readonly history: HistoryRow[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly newId: () => string,
  ) {}

  async place(g: NewOrderGroup): Promise<{ kind: "created" | "duplicate"; groupId: string }> {
    const existing = this.byKey.get(g.idempotencyKey);
    if (existing !== undefined) return { kind: "duplicate", groupId: existing };
    const now = this.clock.nowMs();
    const ids: string[] = [];
    for (const so of g.sellerOrders) {
      ids.push(so.id);
      this.orders.set(so.id, {
        commands: new Set(),
        order: {
          id: so.id,
          orderGroupId: g.id,
          storeId: so.storeId,
          userId: g.userId,
          status: so.status,
          version: 0,
          paymentType: g.paymentType,
          subtotal: so.subtotal,
          shipping: so.shipping,
          discount: so.discount,
          vat: so.vat,
          total: so.total,
          commissionRateBps: so.commissionRateBps,
          paidAtMs: so.paidAtMs,
          acceptByMs: so.acceptByMs,
          dispatchByMs: null,
          acceptedAtMs: null,
          packedAtMs: null,
          shippedAtMs: null,
          deliveredAtMs: null,
          closedAtMs: null,
          cancelledAtMs: null,
          cancelInitiator: null,
          cancelReason: null,
          rejectReason: null,
          createdAtMs: now,
          lines: so.lines.map((l) => ({
            id: l.id,
            skuId: l.skuId,
            productId: l.productId,
            qty: l.qty,
            unitPrice: l.unitPrice,
            discountAlloc: l.discountAlloc,
            vat: l.vat,
            title: l.title,
            sizeLabel: l.sizeLabel ?? null,
          })),
          buyer: so.buyer,
        },
      });
    }
    this.groups.set(g.id, {
      idempotencyKey: g.idempotencyKey,
      orderIds: ids,
      base: {
        id: g.id,
        userId: g.userId,
        status: g.paymentType === "cod" ? "CONFIRMED_COD" : "PAID",
        paymentMethod: g.paymentMethod,
        paymentType: g.paymentType,
        subtotal: g.subtotal,
        shipping: g.shipping,
        discount: g.discount,
        vat: g.vat,
        storeCredit: g.storeCredit,
        total: g.total,
        version: 0,
        createdAtMs: now,
        updatedAtMs: now,
      },
    });
    this.byKey.set(g.idempotencyKey, g.id);
    for (const so of g.sellerOrders) {
      this.outbox.push({
        id: this.newId(),
        type: "seller_order.placed",
        aggregateType: "seller_order",
        aggregateId: so.id,
        occurredAtMs: now,
        payload: {
          seller_order_id: so.id,
          order_group_id: g.id,
          store_id: so.storeId,
          payment_type: g.paymentType,
          total_amount: so.total.amount.toString(),
          accept_by_ms: so.acceptByMs,
        },
      });
    }
    return { kind: "created", groupId: g.id };
  }

  private groupOf(row: GroupRow, scope: OrderScope): OrderGroupRecord {
    const sellerOrders = row.orderIds.flatMap((id) => {
      const e = this.orders.get(id);
      return e !== undefined && visible(e.order, scope) ? [forScope(e.order, scope)] : [];
    });
    return { ...row.base, sellerOrders };
  }

  async getGroupForUser(groupId: string, userId: string): Promise<OrderGroupRecord | null> {
    const row = this.groups.get(groupId);
    if (row === undefined || row.base.userId !== userId) return null;
    return this.groupOf(row, { kind: "shopper", userId });
  }

  async listGroupsForUser(q: ListGroupsQuery): Promise<GroupPage> {
    const rows = [...this.groups.values()]
      .filter((g) => g.base.userId === q.userId)
      .sort((a, b) => b.base.createdAtMs - a.base.createdAtMs || (a.base.id < b.base.id ? 1 : a.base.id > b.base.id ? -1 : 0))
      .filter(
        (g) =>
          q.after === null ||
          g.base.createdAtMs < q.after.createdAtMs ||
          (g.base.createdAtMs === q.after.createdAtMs && g.base.id < q.after.id),
      );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((g) => this.groupOf(g, { kind: "shopper", userId: q.userId })),
      next: rows.length > q.limit && last !== undefined ? { createdAtMs: last.base.createdAtMs, id: last.base.id } : null,
    };
  }

  async locate(id: string): Promise<{ storeId: string; userId: string } | null> {
    const e = this.orders.get(id);
    return e === undefined ? null : { storeId: e.order.storeId, userId: e.order.userId };
  }

  async groupOwner(groupId: string): Promise<string | null> {
    return this.groups.get(groupId)?.base.userId ?? null;
  }

  async getSellerOrder(id: string, scope: OrderScope): Promise<SellerOrderRecord | null> {
    const e = this.orders.get(id);
    return e !== undefined && visible(e.order, scope) ? forScope(e.order, scope) : null;
  }

  async listForStores(q: ListQuery): Promise<ListPage> {
    const rows = [...this.orders.values()]
      .map((e) => e.order)
      .filter((o) => q.storeIds.includes(o.storeId) && visible(o, q.scope))
      .filter((o) => q.status === undefined || o.status === q.status)
      .sort((a, b) => b.createdAtMs - a.createdAtMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .filter(
        (o) =>
          q.after === null ||
          o.createdAtMs < q.after.createdAtMs ||
          (o.createdAtMs === q.after.createdAtMs && o.id < q.after.id),
      );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((o) => forScope(o, q.scope)),
      next: rows.length > q.limit && last !== undefined ? { createdAtMs: last.createdAtMs, id: last.id } : null,
    };
  }

  async hasCommand(id: string, key: string): Promise<boolean> {
    return this.orders.get(id)?.commands.has(key) ?? false;
  }

  async applyTransition(c: TransitionCommand): Promise<ApplyResult> {
    const e = this.orders.get(c.sellerOrderId);
    if (e === undefined || !visible(e.order, c.scope)) return { kind: "not_found" };
    if (e.commands.has(c.commandKey)) return { kind: "replayed", order: forScope(e.order, c.scope) };
    if (e.order.version !== c.expectedVersion) return { kind: "conflict" };
    const t = c.transition;
    // Terminal states are never left (mirrors the seller_orders_guard trigger).
    if (["CLOSED", "REFUNDED", "CANCELLED", "REJECTED_BY_SELLER"].includes(e.order.status) && t.to !== e.order.status) {
      throw new Error(`seller order ${e.order.id} is in terminal state ${e.order.status}`);
    }
    const iso = (ms: number | undefined, prev: number | null): number | null => (ms === undefined ? prev : ms);
    const next: SellerOrderRecord = {
      ...e.order,
      status: t.to,
      version: e.order.version + 1,
      acceptedAtMs: iso(t.stamps.acceptedAtMs, e.order.acceptedAtMs),
      dispatchByMs: iso(t.stamps.dispatchByMs, e.order.dispatchByMs),
      packedAtMs: iso(t.stamps.packedAtMs, e.order.packedAtMs),
      shippedAtMs: iso(t.stamps.shippedAtMs, e.order.shippedAtMs),
      cancelledAtMs: iso(t.stamps.cancelledAtMs, e.order.cancelledAtMs),
      cancelInitiator: t.cancelInitiator ?? e.order.cancelInitiator,
      cancelReason: t.cancelInitiator !== undefined ? t.reasonCode : e.order.cancelReason,
      rejectReason: t.rejectReason ?? e.order.rejectReason,
    };
    e.order = next;
    e.commands.add(c.commandKey);
    this.history.push({
      id: c.historyId,
      sellerOrderId: c.sellerOrderId,
      from: t.from,
      to: t.to,
      event: t.event,
      commandKey: c.commandKey,
      reasonCode: t.reasonCode,
    });
    this.outbox.push(...c.events);
    const group = this.groups.get(next.orderGroupId);
    if (group !== undefined) {
      const siblings = group.orderIds.flatMap((id) => {
        const s = this.orders.get(id);
        return s === undefined ? [] : [s.order.status];
      });
      const r = c.rollup({ id: group.base.id, status: group.base.status }, siblings);
      if (r !== null) {
        group.base = {
          ...group.base,
          status: r.rollup.to as OrderGroupState,
          version: group.base.version + 1,
          updatedAtMs: c.nowMs,
        };
        this.outbox.push(...r.events);
      }
    }
    return { kind: "applied", order: forScope(next, c.scope) };
  }

  async findAcceptSlaExpired(nowMs: number, limit: number): Promise<readonly string[]> {
    return [...this.orders.values()]
      .map((e) => e.order)
      .filter((o) => (o.status === "PAID" || o.status === "CONFIRMED_COD") && o.acceptByMs !== null && o.acceptByMs <= nowMs)
      .sort((a, b) => (a.acceptByMs ?? 0) - (b.acceptByMs ?? 0) || (a.id < b.id ? -1 : 1))
      .slice(0, limit)
      .map((o) => o.id);
  }

  /** Test helpers: states other modules drive (delivery) or concurrent writers. */
  bumpVersionForTest(id: string): void {
    const e = this.orders.get(id);
    if (e !== undefined) e.order = { ...e.order, version: e.order.version + 1 };
  }
  setStatusForTest(id: string, status: SellerOrderRecord["status"], over: Partial<SellerOrderRecord> = {}): void {
    const e = this.orders.get(id);
    if (e !== undefined) e.order = { ...e.order, status, ...over };
  }
}

export class FakeStoreLookup implements StoreLookupPort {
  private readonly stores = new Map<string, StoreSummaryFacts>();

  add(f: StoreSummaryFacts): void {
    this.stores.set(f.id, f);
  }

  async summaries(ids: readonly string[]): Promise<ReadonlyMap<string, StoreSummaryFacts>> {
    const out = new Map<string, StoreSummaryFacts>();
    for (const id of ids) {
      const s = this.stores.get(id);
      if (s !== undefined) out.set(id, s);
    }
    return out;
  }
}
