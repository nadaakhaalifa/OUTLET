import { randomUUID } from "node:crypto";
import type { SqlClient } from "@outlet/db";

/** Inserts bypass foreign keys (session_replication_role = replica, superuser test client) so a test seeds only the columns the rollup reads. */
export const relaxFks = (c: SqlClient): Promise<unknown> => c.query("SET session_replication_role = replica");

export const seedStore = async (c: SqlClient, o: { market?: string; status?: string; nameAr?: string } = {}): Promise<string> => {
  const id = randomUUID();
  await c.query("INSERT INTO stores (id, seller_id, market_id, slug, display_name_ar, display_name_en, kind, ships_from_country, status) VALUES ($1,$2,$3,$4,$5,'Shop','local','EG',$6)",
    [id, randomUUID(), o.market ?? "EG", `s-${id.slice(0, 8)}`, o.nameAr ?? "متجر", o.status ?? "ACTIVE"]);
  return id;
};

export interface GroupSeed {
  readonly market?: string;
  readonly currency?: string;
  readonly status?: string;
  readonly method?: string;
  readonly placedAt: string;
  readonly paidAt?: string | null;
  readonly cancelledAt?: string | null;
  readonly parts: readonly { readonly storeId: string; readonly total: bigint; readonly status?: string }[];
}

/** One order group with one seller order per part; the group total is the sum of the parts (items only, no shipping), as checkout allocates it. */
export const seedGroup = async (c: SqlClient, g: GroupSeed): Promise<string> => {
  const id = randomUUID();
  const market = g.market ?? "EG";
  const currency = g.currency ?? "EGP";
  const total = g.parts.reduce((a, p) => a + p.total, 0n);
  await c.query(
    `INSERT INTO order_groups (id, user_id, market_id, currency, status, funds_flow, checkout_session_id, idempotency_key, payment_method, items_subtotal_minor, shipping_minor, shipping_vat_minor, vat_minor, total_minor, placed_at, paid_at, cancelled_at, cancel_reason)
     VALUES ($1,$2,$3,$4,$5,'collect_payout',$6,$7,$8,$9,0,0,0,$9,$10::timestamptz,$11::timestamptz,$12::timestamptz,$13)`,
    [id, randomUUID(), market, currency, g.status ?? "PAID", randomUUID(), randomUUID(), g.method ?? "card", total.toString(), g.placedAt, g.paidAt ?? null, g.cancelledAt ?? null, g.cancelledAt == null ? null : "customer_request"],
  );
  for (const p of g.parts) {
    await c.query(
      `INSERT INTO seller_orders (id, order_group_id, store_id, user_id, market_id, currency, status, funds_flow, items_subtotal_minor, shipping_minor, shipping_vat_minor, vat_minor, total_minor, commission_bp_snapshot, commission_minor, commission_vat_minor, seller_net_minor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'collect_payout',$8,0,0,0,$8,0,0,0,$8)`,
      [randomUUID(), id, p.storeId, randomUUID(), market, currency, p.status ?? "PAID", p.total.toString()],
    );
  }
  return id;
};

export const seedRefund = async (c: SqlClient, o: { market?: string; amount: bigint; status: string; completedAt?: string | null; createdAt?: string; dueAt?: string | null; currency?: string }): Promise<void> => {
  await c.query(
    `INSERT INTO refunds (id, order_group_id, seller_order_id, user_id, store_id, market_id, reason, route, currency, amount_minor, goods_minor, commission_minor, commission_vat_minor, seller_minor, seller_account, destinations, status, idempotency_key, due_at, completed_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'goodwill','psp_original',$7,$8,$8,0,0,$8,'seller_pending','[]'::jsonb,$9,$10,$11::timestamptz,$12::timestamptz,$13::timestamptz)`,
    [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), o.market ?? "EG", o.currency ?? "EGP", o.amount.toString(), o.status, randomUUID(), o.dueAt ?? null, o.completedAt ?? null, o.createdAt ?? "2026-11-01T00:00:00Z"],
  );
};
