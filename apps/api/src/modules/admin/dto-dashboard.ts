import { Money, SNAPSHOT_TILE_DATA } from "@outlet/reporting";
import { z } from "zod";
import { CursorQuery, pageOf } from "../../platform/pagination.js";

/** docs/api/admin-dashboard-contract.md section 3. Snapshot tile payloads come from @outlet/reporting (one definition for the writer and the reader). */
export const DASHBOARD_RANGES = ["7d", "30d", "90d"] as const;
export const DashboardQuery = z.strictObject({ range: z.enum(DASHBOARD_RANGES).default("30d") });
export type DashboardQuery = z.infer<typeof DashboardQuery>;
export { Money };

const Count = z.int().nonnegative();
const Iso = z.iso.datetime({ offset: true });
const Day = z.iso.date();
const Point = z.strictObject({ day: Day, value: Count });
const MoneyPoint = z.strictObject({ day: Day, value: Money });

/** One tile envelope. `as_of` is when the numbers were computed (snapshot time, or now for live reads). */
const tile = <K extends string, D extends z.ZodType>(key: K, data: D) =>
  z.discriminatedUnion("status", [
    z.strictObject({ key: z.literal(key), status: z.literal("ok"), as_of: Iso, data }),
    z.strictObject({ key: z.literal(key), status: z.literal("forbidden") }),
    z.strictObject({ key: z.literal(key), status: z.literal("unavailable"), reason: z.enum(["not_connected", "read_failed", "stale"]) }),
  ]);

const S = SNAPSHOT_TILE_DATA;

export const DashboardResponse = z.strictObject({
  market_id: z.string().min(2),
  range: z.enum(DASHBOARD_RANGES),
  timezone: z.string(),
  today: Day,
  generated_at: Iso,
  sections: z.strictObject({
    today: z.strictObject({
      // series_14d holds one point per rolled-up day, oldest first; days before the first rollup run are absent (never invented), so it can be shorter than 14.
      orders_today: tile("orders_today", z.strictObject({ count: Count, series_14d: z.array(Point).max(14) })),
      gmv_today: tile("gmv_today", z.strictObject({ gmv: Money, refunded: Money, gmv_7d: Money })),
    }),
    sales: z.strictObject({
      sales_series: tile("sales_series", z.strictObject({ orders: z.array(Point).max(90).nullable(), gmv: z.array(MoneyPoint).max(90).nullable(), total_orders: Count.nullable(), total_gmv: Money.nullable() })),
      orders_by_step: tile("orders_by_step", S.orders_by_step),
      top_stores: tile("top_stores", z.strictObject({
        items: z.array(z.strictObject({ store_id: z.uuid(), name_ar: z.string(), name_en: z.string().nullable(), orders: Count, gmv: Money })).max(5),
        other: z.strictObject({ stores: Count, orders: Count, gmv: Money }),
      })),
      verified_discount_share: tile("verified_discount_share", S.verified_discount_share),
    }),
    orders: z.strictObject({
      seller_sla_breaches: tile("seller_sla_breaches", S.seller_sla_breaches),
      cod_awaiting_confirmation: tile("cod_awaiting_confirmation", S.cod_awaiting_confirmation),
      returns_pipeline: tile("returns_pipeline", S.returns_pipeline),
      disputes_open: tile("disputes_open", S.disputes_open),
    }),
    money: z.strictObject({
      refunds_waiting: tile("refunds_waiting", S.refunds_waiting),
      refunds_overdue: tile("refunds_overdue", S.refunds_overdue),
      payouts: tile("payouts", S.payouts),
      recon_unmatched: tile("recon_unmatched", S.recon_unmatched),
      cod_unremitted: tile("cod_unremitted", z.strictObject({ parcels: Count, amount: Money })),
      ledger_integrity: tile("ledger_integrity", z.strictObject({ balanced: z.boolean(), chain_ok: z.boolean(), checked_at: Iso })),
    }),
    trust: z.strictObject({
      kyc_queue: tile("kyc_queue", z.strictObject({ submitted: Count, needs_info: Count, oldest_at: Iso.nullable() })),
      stores_moderation: tile("stores_moderation", S.stores_moderation),
      price_enforcement: tile("price_enforcement", S.price_enforcement),
      listings_by_status: tile("listings_by_status", S.listings_by_status),
    }),
    privacy: z.strictObject({
      breaches_open: tile("breaches_open", S.breaches_open),
      dsar_queue: tile("dsar_queue", S.dsar_queue),
    }),
    platform: z.strictObject({
      attention_open: tile("attention_open", z.strictObject({ open: Count, acked: Count, by_kind: z.record(z.string().regex(/^[a-z_.]{1,60}$/), Count), oldest_at: Iso.nullable() })),
      approvals_pending: tile("approvals_pending", z.strictObject({ for_me: Count, soonest_expires_at: Iso.nullable() })),
      elevations_active: tile("elevations_active", z.strictObject({ active: Count, pending: Count, scope: z.enum(["own", "market"]) })),
      kill_switches: tile("kill_switches", z.strictObject({ engaged_money: z.array(z.string()).max(100), engaged_ui: z.array(z.string()).max(100) })),
    }),
  }),
});
export type DashboardResponse = z.infer<typeof DashboardResponse>;

// ---- ops attention queue (packages/ops-attention README): list open, ack, resolve
export const ATTENTION_RESOLUTION_CODES = ["FIXED_MANUALLY", "REFUNDED_OFFLINE", "RETRIED_OK", "NOT_AN_ISSUE", "DUPLICATE", "ESCALATED"] as const;
export const AttentionIdParams = z.strictObject({ attention_id: z.uuid() });
export type AttentionIdParams = z.infer<typeof AttentionIdParams>;
export const AttentionAckInput = z.strictObject({});
export type AttentionAckInput = z.infer<typeof AttentionAckInput>;
export const AttentionResolveInput = z.strictObject({ resolution_code: z.enum(ATTENTION_RESOLUTION_CODES) });
export type AttentionResolveInput = z.infer<typeof AttentionResolveInput>;
export const AttentionItemDto = z.strictObject({
  id: z.uuid(),
  kind: z.enum(["refund.attention", "promotions.settle_attention", "shipment.cancel_attention"]),
  ref_type: z.enum(["refund", "order_group", "shipment", "event"]),
  ref_id: z.string().max(200),
  /** Ids and short code tokens only (whitelisted by the consumer): no names, contact data or amounts. */
  payload: z.record(z.string().max(100), z.string().max(200)),
  status: z.enum(["OPEN", "ACKED", "RESOLVED"]),
  created_at: Iso,
  acked_by: z.uuid().nullable(),
  acked_at: Iso.nullable(),
  resolved_at: Iso.nullable(),
  resolution_code: z.enum(ATTENTION_RESOLUTION_CODES).nullable(),
});
export type AttentionItemDto = z.infer<typeof AttentionItemDto>;
export const AttentionQuery = CursorQuery;
export type AttentionQuery = z.infer<typeof AttentionQuery>;
export const AttentionItemPage = pageOf(AttentionItemDto);
export type AttentionItemPage = z.infer<typeof AttentionItemPage>;
