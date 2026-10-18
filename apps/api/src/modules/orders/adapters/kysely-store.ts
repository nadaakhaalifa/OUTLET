import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { CANCEL_INITIATORS, REJECT_REASONS, money, type OrderGroupState } from "../domain/bridge";
import type { Clock } from "../../../platform/ports";
import { analyticsConsentGranted, appendAnalyticsDrafts, type AnalyticsProducers } from "../../analytics-ingest";
import {
  PAYMENT_METHODS,
  type ApplyResult,
  type BuyerContactRecord,
  type ListPage,
  type GroupPage,
  type ListGroupsQuery,
  type ListQuery,
  type NewOrderGroup,
  type OrderGroupRecord,
  type OrderLineRecord,
  type OrderRepository,
  type OrderScope,
  type OutboxEventDraft,
  type SellerOrderRecord,
  type TransitionCommand,
} from "../domain/ports";
import { SELLER_ORDER_STATES, ORDER_GROUP_STATES } from "../domain/bridge";

/** Raw SQL only, rows validated with Zod (same approach as the cart and inventory adapters). */
export type OrdersDb = Kysely<Record<string, never>>;

const Int = z.string().regex(/^-?\d+$/);
const Ms = Int.transform((s) => Number(s));
const Amount = Int.transform((s) => BigInt(s));
const MAX_DATE_MS = 253_402_300_799_999; // 9999-12-31, safe for ISO strings and Postgres
/** Clamped so a forged out-of-range cursor can never raise RangeError. */
const iso = (ms: number): string => new Date(Math.min(Math.max(ms, 0), MAX_DATE_MS)).toISOString();
const isoOrNull = (ms: number | undefined): string | null => (ms === undefined ? null : iso(ms));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAYMENT_TYPES = z.enum(["prepaid", "cod"]);

const OrderRow = z.object({
  id: z.string(),
  order_group_id: z.string(),
  store_id: z.string(),
  user_id: z.string(),
  status: z.enum(SELLER_ORDER_STATES),
  version: z.number().int(),
  payment_type: PAYMENT_TYPES,
  subtotal: Amount,
  shipping: Amount,
  discount: Amount,
  vat: Amount,
  total: Amount,
  commission_bps: z.number().int(),
  paid_ms: Ms.nullable(),
  accept_by_ms: Ms.nullable(),
  dispatch_by_ms: Ms.nullable(),
  accepted_ms: Ms.nullable(),
  packed_ms: Ms.nullable(),
  shipped_ms: Ms.nullable(),
  delivered_ms: Ms.nullable(),
  closed_ms: Ms.nullable(),
  cancelled_ms: Ms.nullable(),
  cancel_initiator: z.enum(CANCEL_INITIATORS).nullable(),
  cancel_reason: z.string().nullable(),
  reject_reason: z.enum(REJECT_REASONS).nullable(),
  created_ms: Ms,
});
const LineRow = z.object({
  id: z.string(),
  seller_order_id: z.string(),
  sku_id: z.string(),
  product_id: z.string(),
  qty: z.number().int(),
  unit_price: Amount,
  discount: Amount,
  vat: Amount,
  title_ar: z.string(),
  title_en: z.string().nullable(),
  size_label: z.string().nullable(),
});
const ContactRow = z.object({
  seller_order_id: z.string(),
  first_name: z.string().nullable(),
  phone_relay: z.string().nullable(),
  governorate_code: z.string(),
});
const GroupRow = z.object({
  id: z.string(),
  user_id: z.string(),
  status: z.enum(ORDER_GROUP_STATES),
  payment_method: z.enum(PAYMENT_METHODS),
  payment_type: PAYMENT_TYPES,
  subtotal: Amount,
  shipping: Amount,
  discount: Amount,
  vat: Amount,
  store_credit: Amount,
  total: Amount,
  version: z.number().int(),
  created_ms: Ms,
  updated_ms: Ms,
});

const ms = (col: string): string => `floor(extract(epoch from ${col}) * 1000)::text`;
const ORDER_COLS = sql.raw(`
  id::text as id, order_group_id::text as order_group_id, store_id::text as store_id, user_id::text as user_id,
  status, version, payment_type,
  subtotal_amount::text as subtotal, shipping_amount::text as shipping, discount_amount::text as discount,
  vat_amount::text as vat, total_amount::text as total, commission_rate_snapshot_bps as commission_bps,
  ${ms("paid_at")} as paid_ms, ${ms("accept_by")} as accept_by_ms, ${ms("dispatch_by")} as dispatch_by_ms,
  ${ms("accepted_at")} as accepted_ms, ${ms("packed_at")} as packed_ms, ${ms("shipped_at")} as shipped_ms,
  ${ms("delivered_at")} as delivered_ms, ${ms("closed_at")} as closed_ms, ${ms("cancelled_at")} as cancelled_ms,
  cancel_initiator, cancel_reason, reject_reason, ${ms("created_at")} as created_ms`);

/**
 * Postgres adapter. Each call is ONE transaction that drops to `app_user` and sets the caller's RLS
 * identity (role, user, stores), so tenant isolation is enforced by the database for every read and
 * for the row-locking read that opens each command. After that read has authorised the actor on the
 * row, the transaction raises to `system` for derived bookkeeping that no tenant may write directly
 * (status history, group roll-up, outbox), all in the SAME transaction (A2.7).
 */
export class KyselyOrderRepository implements OrderRepository {
  constructor(
    private readonly db: OrdersDb,
    private readonly clock: Clock,
    private readonly applicationRole: string | null = "app_user",
    /** Server analytics producers (kill.analytics.producers). Null or blocked: nothing analytics is written. */
    private readonly analytics: AnalyticsProducers | null = null,
  ) {}

  private async tx<T>(scope: OrderScope, run: (trx: OrdersDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      const t = trx as unknown as OrdersDb;
      if (this.applicationRole !== null) {
        if (!/^[a-z_][a-z0-9_]*$/.test(this.applicationRole)) throw new RangeError("invalid role name");
        await sql`SET LOCAL ROLE ${sql.id(this.applicationRole)}`.execute(t);
      }
      const role = scope.kind === "system" ? "system" : scope.kind === "seller" ? "seller" : "customer";
      const userId = scope.kind === "system" ? "" : scope.userId;
      const stores = scope.kind === "seller" ? scope.storeIds.join(",") : "";
      await sql`select set_config('app.role', ${role}, true), set_config('app.user_id', ${userId}, true),
                       set_config('app.store_ids', ${stores}, true)`.execute(t);
      return run(t);
    });
  }

  private static async elevate(trx: OrdersDb): Promise<void> {
    await sql`select set_config('app.role', 'system', true)`.execute(trx);
  }

  private static async loadOrders(trx: OrdersDb, where: ReturnType<typeof sql>): Promise<SellerOrderRecord[]> {
    const r = await sql<unknown>`select ${ORDER_COLS} from seller_orders where ${where}`.execute(trx);
    return KyselyOrderRepository.hydrate(trx, r.rows.map((x) => OrderRow.parse(x)));
  }

  private static async hydrate(trx: OrdersDb, rows: readonly z.output<typeof OrderRow>[]): Promise<SellerOrderRecord[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((o) => o.id);
    const ls = await sql<unknown>`
      select id::text as id, seller_order_id::text as seller_order_id, sku_id::text as sku_id,
             product_id::text as product_id, qty, unit_price_amount::text as unit_price,
             discount_amount::text as discount, vat_amount::text as vat, title_ar, title_en, size_label
        from order_lines where seller_order_id::text = any (${ids}::text[]) order by position, id`.execute(trx);
    const cs = await sql<unknown>`
      select seller_order_id::text as seller_order_id, first_name, phone_relay, governorate_code
        from order_buyer_contacts where seller_order_id::text = any (${ids}::text[])`.execute(trx);
    const lines = new Map<string, OrderLineRecord[]>();
    for (const raw of ls.rows) {
      const l = LineRow.parse(raw);
      const rec: OrderLineRecord = {
        id: l.id,
        skuId: l.sku_id,
        productId: l.product_id,
        qty: l.qty,
        unitPrice: money(l.unit_price),
        discountAlloc: money(l.discount),
        vat: money(l.vat),
        title: { ar: l.title_ar, ...(l.title_en !== null ? { en: l.title_en } : {}) },
        sizeLabel: l.size_label,
      };
      lines.set(l.seller_order_id, [...(lines.get(l.seller_order_id) ?? []), rec]);
    }
    const contacts = new Map<string, BuyerContactRecord>();
    for (const raw of cs.rows) {
      const c = ContactRow.parse(raw);
      contacts.set(c.seller_order_id, {
        firstName: c.first_name,
        phoneRelay: c.phone_relay,
        governorateCode: c.governorate_code,
      });
    }
    return rows.map((o) => ({
      id: o.id,
      orderGroupId: o.order_group_id,
      storeId: o.store_id,
      userId: o.user_id,
      status: o.status,
      version: o.version,
      paymentType: o.payment_type,
      subtotal: money(o.subtotal),
      shipping: money(o.shipping),
      discount: money(o.discount),
      vat: money(o.vat),
      total: money(o.total),
      commissionRateBps: o.commission_bps,
      paidAtMs: o.paid_ms,
      acceptByMs: o.accept_by_ms,
      dispatchByMs: o.dispatch_by_ms,
      acceptedAtMs: o.accepted_ms,
      packedAtMs: o.packed_ms,
      shippedAtMs: o.shipped_ms,
      deliveredAtMs: o.delivered_ms,
      closedAtMs: o.closed_ms,
      cancelledAtMs: o.cancelled_ms,
      cancelInitiator: o.cancel_initiator,
      cancelReason: o.cancel_reason,
      rejectReason: o.reject_reason,
      createdAtMs: o.created_ms,
      lines: lines.get(o.id) ?? [],
      buyer: contacts.get(o.id) ?? null,
    }));
  }

  private static async insertEvent(trx: OrdersDb, e: OutboxEventDraft): Promise<void> {
    await sql`
      insert into outbox_events (id, occurred_at, aggregate_type, aggregate_id, event_type, ordering_key, payload)
      values (${e.id}::uuid, ${iso(e.occurredAtMs)}::timestamptz, ${e.aggregateType}, ${e.aggregateId}::uuid,
              ${e.type}, ${`${e.aggregateType}:${e.aggregateId}`}, ${JSON.stringify(e.payload)}::jsonb)`.execute(trx);
  }

  // ------------------------------------------------------------------ intake

  async place(g: NewOrderGroup): Promise<{ kind: "created" | "duplicate"; groupId: string }> {
    const now = this.clock.nowMs();
    // Read once, before the transaction: never a flag lookup inside the money transaction.
    const analyticsOn = this.analytics !== null && (await this.analytics.enabled());
    return this.tx({ kind: "system" }, async (trx) => {
      const ins = await sql<{ id: string }>`
        insert into order_groups (id, user_id, status, payment_method, payment_type, subtotal_amount, shipping_amount,
                                  discount_amount, vat_amount, store_credit_amount, total_amount, idempotency_key,
                                  version, placed_at, created_at, updated_at)
        values (${g.id}::uuid, ${g.userId}::uuid, ${g.paymentType === "cod" ? "CONFIRMED_COD" : "PAID"},
                ${g.paymentMethod}, ${g.paymentType}, ${g.subtotal.amount.toString()}::bigint,
                ${g.shipping.amount.toString()}::bigint, ${g.discount.amount.toString()}::bigint,
                ${g.vat.amount.toString()}::bigint, ${g.storeCredit.amount.toString()}::bigint,
                ${g.total.amount.toString()}::bigint, ${g.idempotencyKey}, 0,
                ${iso(g.placedAtMs)}::timestamptz, ${iso(now)}::timestamptz, ${iso(now)}::timestamptz)
        on conflict (idempotency_key) do nothing
        returning id::text as id`.execute(trx);
      if (ins.rows.length === 0) {
        const ex = await sql<{ id: string }>`
          select id::text as id from order_groups where idempotency_key = ${g.idempotencyKey}`.execute(trx);
        const id = ex.rows[0]?.id;
        if (id === undefined) throw new Error("order group vanished after conflict");
        return { kind: "duplicate" as const, groupId: id };
      }
      const consented = analyticsOn ? await analyticsConsentGranted(trx, g.userId) : false;
      for (const so of g.sellerOrders) {
        await sql`
          insert into seller_orders (id, order_group_id, store_id, user_id, status, version, payment_type,
                                     subtotal_amount, shipping_amount, discount_amount, vat_amount, total_amount,
                                     commission_rate_snapshot_bps, paid_at, accept_by, created_at, updated_at)
          values (${so.id}::uuid, ${g.id}::uuid, ${so.storeId}::uuid, ${g.userId}::uuid, ${so.status}, 0,
                  ${g.paymentType}, ${so.subtotal.amount.toString()}::bigint, ${so.shipping.amount.toString()}::bigint,
                  ${so.discount.amount.toString()}::bigint, ${so.vat.amount.toString()}::bigint,
                  ${so.total.amount.toString()}::bigint, ${so.commissionRateBps},
                  ${iso(so.paidAtMs)}::timestamptz, ${iso(so.acceptByMs)}::timestamptz,
                  ${iso(now)}::timestamptz, ${iso(now)}::timestamptz)`.execute(trx);
        let position = 0;
        for (const l of so.lines) {
          await sql`
            insert into order_lines (id, seller_order_id, store_id, sku_id, product_id, qty, unit_price_amount,
                                     discount_amount, vat_amount, title_ar, title_en, size_label, position)
            values (${l.id}::uuid, ${so.id}::uuid, ${so.storeId}::uuid, ${l.skuId}::uuid, ${l.productId}::uuid, ${l.qty},
                    ${l.unitPrice.amount.toString()}::bigint, ${l.discountAlloc.amount.toString()}::bigint,
                    ${l.vat.amount.toString()}::bigint, ${l.title.ar}, ${l.title.en ?? null}, ${l.sizeLabel ?? null},
                    ${position})`.execute(trx);
          position += 1;
        }
        await sql`
          insert into order_buyer_contacts (seller_order_id, store_id, first_name, phone_relay, governorate_code)
          values (${so.id}::uuid, ${so.storeId}::uuid, ${so.buyer.firstName}, ${so.buyer.phoneRelay},
                  ${so.buyer.governorateCode})`.execute(trx);
        const placedExtra =
          analyticsOn && this.analytics !== null
            ? this.analytics.sellerOrderPlaced({ userId: g.userId, consented, placedAtMs: g.placedAtMs, lines: so.lines })
            : {};
        await sql`
          insert into outbox_events (id, occurred_at, aggregate_type, aggregate_id, event_type, ordering_key, payload)
          values (gen_random_uuid(), ${iso(now)}::timestamptz, 'seller_order', ${so.id}::uuid, 'seller_order.placed',
                  ${`seller_order:${so.id}`},
                  ${JSON.stringify({
                    seller_order_id: so.id,
                    order_group_id: g.id,
                    store_id: so.storeId,
                    payment_type: g.paymentType,
                    total_amount: so.total.amount.toString(),
                    accept_by_ms: so.acceptByMs,
                    ...placedExtra,
                  })}::jsonb)`.execute(trx);
        if (analyticsOn && this.analytics !== null) {
          const a = this.analytics;
          await appendAnalyticsDrafts(
            trx,
            so.lines.flatMap((l) => {
              const d = a.orderLinePurchased({
                userId: g.userId,
                consented,
                sellerOrderId: so.id,
                storeId: so.storeId,
                commissionRateBps: so.commissionRateBps,
                governorate: so.buyer.governorateCode,
                purchasedAtMs: so.paidAtMs,
                line: {
                  orderLineId: l.id,
                  productId: l.productId,
                  skuId: l.skuId,
                  qty: l.qty,
                  unitPriceMinor: l.unitPrice.amount,
                  discountAllocMinor: l.discountAlloc.amount,
                  sizeLabel: l.sizeLabel ?? null,
                },
              });
              return d === null ? [] : [d];
            }),
          );
        }
      }
      return { kind: "created" as const, groupId: g.id };
    });
  }

  // ------------------------------------------------------------------ reads

  async getGroupForUser(groupId: string, userId: string): Promise<OrderGroupRecord | null> {
    if (!UUID.test(groupId)) return null;
    return this.tx({ kind: "shopper", userId }, async (trx) => {
      const g = await sql<unknown>`
        select id::text as id, user_id::text as user_id, status, payment_method, payment_type,
               subtotal_amount::text as subtotal, shipping_amount::text as shipping, discount_amount::text as discount,
               vat_amount::text as vat, store_credit_amount::text as store_credit, total_amount::text as total,
               version, ${sql.raw(ms("created_at"))} as created_ms, ${sql.raw(ms("updated_at"))} as updated_ms
          from order_groups where id = ${groupId}::uuid and user_id = ${userId}::uuid`.execute(trx);
      const head = g.rows[0];
      if (head === undefined) return null;
      const r = GroupRow.parse(head);
      const orders = await KyselyOrderRepository.loadOrders(trx, sql`order_group_id = ${groupId}::uuid order by created_at, id`);
      return {
        id: r.id,
        userId: r.user_id,
        status: r.status as OrderGroupState,
        paymentMethod: r.payment_method,
        paymentType: r.payment_type,
        subtotal: money(r.subtotal),
        shipping: money(r.shipping),
        discount: money(r.discount),
        vat: money(r.vat),
        storeCredit: money(r.store_credit),
        total: money(r.total),
        version: r.version,
        createdAtMs: r.created_ms,
        updatedAtMs: r.updated_ms,
        sellerOrders: orders.map((o) => ({ ...o, buyer: null })),
      };
    });
  }

  async listGroupsForUser(q: ListGroupsQuery): Promise<GroupPage> {
    if (!UUID.test(q.userId)) return { items: [], next: null };
    return this.tx({ kind: "shopper", userId: q.userId }, async (trx) => {
      const after =
        q.after === null ? sql`` : sql`and (created_at, id) < (${iso(q.after.createdAtMs)}::timestamptz, ${q.after.id}::uuid)`;
      const g = await sql<unknown>`
        select id::text as id, user_id::text as user_id, status, payment_method, payment_type,
               subtotal_amount::text as subtotal, shipping_amount::text as shipping, discount_amount::text as discount,
               vat_amount::text as vat, store_credit_amount::text as store_credit, total_amount::text as total,
               version, ${sql.raw(ms("created_at"))} as created_ms, ${sql.raw(ms("updated_at"))} as updated_ms
          from order_groups where user_id = ${q.userId}::uuid ${after}
         order by created_at desc, id desc limit ${q.limit + 1}`.execute(trx);
      const rows = g.rows.map((x) => GroupRow.parse(x));
      const page = rows.slice(0, q.limit);
      const items: OrderGroupRecord[] = [];
      for (const r of page) {
        const orders = await KyselyOrderRepository.loadOrders(trx, sql`order_group_id = ${r.id}::uuid order by created_at, id`);
        items.push({
          id: r.id,
          userId: r.user_id,
          status: r.status as OrderGroupState,
          paymentMethod: r.payment_method,
          paymentType: r.payment_type,
          subtotal: money(r.subtotal),
          shipping: money(r.shipping),
          discount: money(r.discount),
          vat: money(r.vat),
          storeCredit: money(r.store_credit),
          total: money(r.total),
          version: r.version,
          createdAtMs: r.created_ms,
          updatedAtMs: r.updated_ms,
          sellerOrders: orders.map((o) => ({ ...o, buyer: null })),
        });
      }
      const last = page[page.length - 1];
      return {
        items,
        next: rows.length > q.limit && last !== undefined ? { createdAtMs: last.created_ms, id: last.id } : null,
      };
    });
  }

  async locate(id: string): Promise<{ storeId: string; userId: string } | null> {
    if (!UUID.test(id)) return null;
    return this.tx({ kind: "system" }, async (trx) => {
      const r = await sql<{ store_id: string; user_id: string }>`
        select store_id::text as store_id, user_id::text as user_id from seller_orders where id = ${id}::uuid`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : { storeId: row.store_id, userId: row.user_id };
    });
  }

  async groupOwner(groupId: string): Promise<string | null> {
    if (!UUID.test(groupId)) return null;
    return this.tx({ kind: "system" }, async (trx) => {
      const r = await sql<{ user_id: string }>`
        select user_id::text as user_id from order_groups where id = ${groupId}::uuid`.execute(trx);
      return r.rows[0]?.user_id ?? null;
    });
  }

  async getSellerOrder(id: string, scope: OrderScope): Promise<SellerOrderRecord | null> {
    if (!UUID.test(id)) return null;
    return this.tx(scope, async (trx) => {
      const [o] = await KyselyOrderRepository.loadOrders(trx, sql`id = ${id}::uuid`);
      return o ?? null;
    });
  }

  async listForStores(q: ListQuery): Promise<ListPage> {
    const storeIds = q.storeIds.filter((s) => UUID.test(s));
    if (storeIds.length === 0) return { items: [], next: null };
    return this.tx(q.scope, async (trx) => {
      const after =
        q.after === null
          ? sql``
          : sql`and (created_at, id) < (${iso(q.after.createdAtMs)}::timestamptz, ${q.after.id}::uuid)`;
      const status = q.status === undefined ? sql`` : sql`and status = ${q.status}`;
      const r = await sql<unknown>`
        select ${ORDER_COLS} from seller_orders
         where store_id::text = any (${storeIds}::text[]) ${status} ${after}
         order by created_at desc, id desc limit ${q.limit + 1}`.execute(trx);
      const rows = r.rows.map((x) => OrderRow.parse(x));
      const page = rows.slice(0, q.limit);
      const items = await KyselyOrderRepository.hydrate(trx, page);
      const last = page[page.length - 1];
      return {
        items,
        next: rows.length > q.limit && last !== undefined ? { createdAtMs: last.created_ms, id: last.id } : null,
      };
    });
  }

  async hasCommand(id: string, key: string): Promise<boolean> {
    if (!UUID.test(id)) return false;
    return this.tx({ kind: "system" }, async (trx) => {
      const r = await sql`select 1 from order_status_history
                           where seller_order_id = ${id}::uuid and command_key = ${key}`.execute(trx);
      return r.rows.length > 0;
    });
  }

  async findAcceptSlaExpired(nowMs: number, limit: number): Promise<readonly string[]> {
    return this.tx({ kind: "system" }, async (trx) => {
      const r = await sql<{ id: string }>`
        select id::text as id from seller_orders
         where status in ('PAID', 'CONFIRMED_COD') and accept_by <= ${iso(nowMs)}::timestamptz
         order by accept_by, id limit ${limit}`.execute(trx);
      return r.rows.map((x) => x.id);
    });
  }

  async findCloseCandidates(deliveredBeforeMs: number, limit: number): Promise<readonly string[]> {
    return this.tx({ kind: "system" }, async (trx) => {
      const r = await sql<{ id: string }>`
        select id::text as id from seller_orders
         where status = 'DELIVERED' and delivered_at <= ${iso(deliveredBeforeMs)}::timestamptz
         order by delivered_at, id limit ${limit}`.execute(trx);
      return r.rows.map((x) => x.id);
    });
  }

  // ------------------------------------------------------------------ command

  async applyTransition(c: TransitionCommand): Promise<ApplyResult> {
    if (!UUID.test(c.sellerOrderId)) return { kind: "not_found" };
    const t = c.transition;
    return this.tx(c.scope, async (trx) => {
      // 1. Authorising, row-locking read under the CALLER's RLS identity: zero rows = not theirs.
      const locked = await sql<{ version: number; store_id: string; order_group_id: string }>`
        select version, store_id::text as store_id, order_group_id::text as order_group_id
          from seller_orders where id = ${c.sellerOrderId}::uuid for update`.execute(trx);
      const head = locked.rows[0];
      if (head === undefined) return { kind: "not_found" as const };
      await KyselyOrderRepository.elevate(trx);

      const prior = await sql`select 1 from order_status_history
                               where seller_order_id = ${c.sellerOrderId}::uuid and command_key = ${c.commandKey}`.execute(trx);
      const reload = async (): Promise<SellerOrderRecord> => {
        const [o] = await KyselyOrderRepository.loadOrders(trx, sql`id = ${c.sellerOrderId}::uuid`);
        if (o === undefined) throw new Error("seller order vanished");
        return c.scope.kind === "shopper" ? { ...o, buyer: null } : o;
      };
      if (prior.rows.length > 0) return { kind: "replayed" as const, order: await reload() };
      if (head.version !== c.expectedVersion) return { kind: "conflict" as const };

      // 2. State change (the DB trigger refuses to leave a terminal state).
      await sql`
        update seller_orders set
          status = ${t.to}, version = version + 1,
          accepted_at = coalesce(${isoOrNull(t.stamps.acceptedAtMs)}::timestamptz, accepted_at),
          dispatch_by = coalesce(${isoOrNull(t.stamps.dispatchByMs)}::timestamptz, dispatch_by),
          packed_at = coalesce(${isoOrNull(t.stamps.packedAtMs)}::timestamptz, packed_at),
          shipped_at = coalesce(${isoOrNull(t.stamps.shippedAtMs)}::timestamptz, shipped_at),
          delivered_at = coalesce(${isoOrNull(t.stamps.deliveredAtMs)}::timestamptz, delivered_at),
          closed_at = coalesce(${isoOrNull(t.stamps.closedAtMs)}::timestamptz, closed_at),
          cancelled_at = coalesce(${isoOrNull(t.stamps.cancelledAtMs)}::timestamptz, cancelled_at),
          cancel_initiator = coalesce(${t.cancelInitiator ?? null}, cancel_initiator),
          cancel_reason = coalesce(${t.cancelInitiator === undefined ? null : t.reasonCode}, cancel_reason),
          reject_reason = coalesce(${t.rejectReason ?? null}, reject_reason)
        where id = ${c.sellerOrderId}::uuid and version = ${c.expectedVersion}`.execute(trx);

      // 3. History, group roll-up and outbox: same transaction.
      await sql`
        insert into order_status_history (id, seller_order_id, store_id, from_status, to_status, event, actor_type,
                                          actor_id, reason_code, command_key, occurred_at)
        values (${c.historyId}::uuid, ${c.sellerOrderId}::uuid, ${head.store_id}::uuid, ${t.from}, ${t.to}, ${t.event},
                ${t.actorType}, ${c.actorId}::uuid, ${t.reasonCode}, ${c.commandKey}, ${iso(c.nowMs)}::timestamptz)`.execute(trx);

      const events: OutboxEventDraft[] = [...c.events];
      const grp = await sql<{ id: string; status: OrderGroupState }>`
        select id::text as id, status from order_groups where id = ${head.order_group_id}::uuid for update`.execute(trx);
      const group = grp.rows[0];
      if (group !== undefined) {
        const sib = await sql<{ status: string }>`
          select status from seller_orders where order_group_id = ${head.order_group_id}::uuid`.execute(trx);
        const states = sib.rows.map((r) => z.enum(SELLER_ORDER_STATES).parse(r.status));
        const r = c.rollup({ id: group.id, status: z.enum(ORDER_GROUP_STATES).parse(group.status) }, states);
        if (r !== null) {
          await sql`update order_groups set status = ${r.rollup.to}, version = version + 1
                     where id = ${group.id}::uuid`.execute(trx);
          events.push(...r.events);
        }
      }
      for (const e of events) await KyselyOrderRepository.insertEvent(trx, e);
      return { kind: "applied" as const, order: await reload() };
    });
  }
}
