import { withDbContext } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import { money } from "@outlet/money";
import type { Currency, Money } from "@outlet/money";
import { authorize } from "@outlet/policy";
import type { Action, Principal } from "@outlet/policy";
import { decodeCursor, encodeCursor } from "../../platform/cursor.js";
import { wireMoney } from "../../platform/money-wire.js";
import { Problems } from "../../platform/problem.js";
import { MAX_PAYOUT_LINES } from "./dto.js";
import type { PayoutDetail, PayoutPage, PayoutsQuery, SellerBalance, SellerStatement, StatementQuery } from "./dto.js";

type PayoutStatus = PayoutDetail["status"];

interface PayoutRow {
  id: string; status: PayoutStatus; cycle_start: string; cycle_end: string; gross: string; adj: string; net: string; currency: string;
  created_at: Date; sent_at: Date | null; settled_at: Date | null;
}
const PAYOUT_SQL = `SELECT id, status, cycle_start::text AS cycle_start, cycle_end::text AS cycle_end, gross_minor::text AS gross, adjustments_minor::text AS adj, net_minor::text AS net,
       currency, created_at, sent_at, settled_at FROM payouts`;

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const m = (v: string, c: string): Money => money(BigInt(v), c as Currency);
const wirePayout = (r: PayoutRow) => ({
  id: r.id, status: r.status, cycle_start: r.cycle_start, cycle_end: r.cycle_end, gross: wireMoney(m(r.gross, r.currency)), adjustments: wireMoney(m(r.adj, r.currency)),
  net: wireMoney(m(r.net, r.currency)), created_at: r.created_at.toISOString(), sent_at: iso(r.sent_at), settled_at: iso(r.settled_at),
});

/** Journal kinds that credit the seller for an order, the refund kind and the payout kind. Everything else on the store's accounts is an adjustment; line_closed nets to zero between the two accounts. */
const ORDER_KINDS = ["order_recognised", "order_delivered_cod"];
const REFUND_KINDS = ["refund_issued"];
const PAYOUT_KINDS = ["payout_sent"];

export interface SellerFinanceDeps {
  readonly client: RoleSqlClient<"outlet_app">;
  readonly marketId: string;
  readonly currency: Currency;
  readonly now: () => Date;
}

/**
 * Seller Center finance (read only). Runs as outlet_app in the store context: payouts, payout_lines, payout_accruals and seller_orders are
 * RLS-isolated by (market, store). The ledger tables carry no RLS (ADR-0011, migration 0008), so every ledger read here is pinned in SQL to the
 * store's own accounts (owner_type = 'store', owner_id = the context store) and the market; that filter is the tenant guard for those reads.
 */
export class SellerFinanceService {
  constructor(private readonly d: SellerFinanceDeps) {}

  private access(actor: Principal, action: Action, storeId: string): void {
    if (actor.kind !== "seller_staff") throw Problems.forbidden();
    const r = authorize(actor, action, { type: "payout", storeId, marketId: this.d.marketId });
    if (r.effect === "deny") throw r.reason === "not_found" ? Problems.notFound() : Problems.forbidden();
  }

  private store<T>(storeId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.d.client, { kind: "store", marketId: this.d.marketId, storeId }, fn);
  }

  async balance(actor: Principal, storeId: string): Promise<SellerBalance> {
    this.access(actor, "payout.read", storeId);
    const cur = this.d.currency;
    const { accounts, payouts } = await this.store(storeId, async (tx) => ({
      accounts: (
        await tx.query<{ type: string; total: string }>(
          `SELECT a.type, COALESCE(SUM(-p.amount_minor), 0)::text AS total
             FROM ledger_accounts a LEFT JOIN postings p ON p.account_id = a.id
            WHERE a.market_id = $1 AND a.owner_type = 'store' AND a.owner_id = $2 AND a.currency = $3 AND a.type IN ('seller_pending', 'seller_available')
            GROUP BY a.type`,
          [this.d.marketId, storeId, cur],
        )
      ).rows,
      payouts: (
        await tx.query<{ status: string; total: string }>(
          `SELECT status, COALESCE(SUM(net_minor), 0)::text AS total FROM payouts WHERE store_id = $1 AND currency = $2 GROUP BY status`,
          [storeId, cur],
        )
      ).rows,
    }));
    const acct = (type: string): bigint => BigInt(accounts.find((r) => r.type === type)?.total ?? "0");
    const pay = (...statuses: string[]): bigint => payouts.filter((r) => statuses.includes(r.status)).reduce((s, r) => s + BigInt(r.total), 0n);
    const pending = acct("seller_pending");
    const available = acct("seller_available");
    return {
      currency: cur,
      pending: wireMoney(money(pending, cur)),
      available: wireMoney(money(available, cur)),
      total: wireMoney(money(pending + available, cur)),
      payouts: {
        scheduled: wireMoney(money(pay("SCHEDULED", "APPROVED"), cur)),
        held: wireMoney(money(pay("ON_HOLD"), cur)),
        in_transit: wireMoney(money(pay("SENT"), cur)),
        paid_to_date: wireMoney(money(pay("SETTLED"), cur)),
      },
      server_time: this.d.now().toISOString(),
    };
  }

  async listPayouts(actor: Principal, storeId: string, q: PayoutsQuery): Promise<PayoutPage> {
    this.access(actor, "payout.read", storeId);
    const after = q.cursor === undefined ? undefined : decodeCursor(q.cursor, 2);
    const rows = (
      await this.store(storeId, (tx) =>
        tx.query<PayoutRow>(
          `${PAYOUT_SQL}
            WHERE store_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
            ORDER BY created_at DESC, id DESC LIMIT $5`,
          [storeId, q.status ?? null, after?.[0] ?? null, after?.[1] ?? null, q.limit + 1],
        ),
      )
    ).rows;
    const items = rows.slice(0, q.limit);
    const last = items[items.length - 1];
    return { items: items.map(wirePayout), next_cursor: rows.length > q.limit && last !== undefined ? encodeCursor(last.created_at.toISOString(), last.id) : null };
  }

  async getPayout(actor: Principal, storeId: string, id: string): Promise<PayoutDetail> {
    this.access(actor, "payout.read", storeId);
    const { p, lines } = await this.store(storeId, async (tx) => {
      const p = (await tx.query<PayoutRow>(`${PAYOUT_SQL} WHERE id = $1 AND store_id = $2`, [id, storeId])).rows[0];
      if (p === undefined) return { p: undefined, lines: [] };
      const lines = (
        await tx.query<{ kind: "order" | "adjustment"; seller_order_id: string | null; amount: string; currency: string }>(
          `SELECT l.kind, a.seller_order_id, l.amount_minor::text AS amount, l.currency
             FROM payout_lines l LEFT JOIN payout_accruals a ON a.id = l.accrual_id
            WHERE l.payout_id = $1 AND l.store_id = $2 ORDER BY l.kind, l.id LIMIT $3`,
          [id, storeId, MAX_PAYOUT_LINES + 1],
        )
      ).rows;
      return { p, lines };
    });
    if (p === undefined) throw Problems.notFound();
    return {
      ...wirePayout(p),
      lines: lines.slice(0, MAX_PAYOUT_LINES).map((l) => ({ kind: l.kind, seller_order_id: l.seller_order_id, amount: wireMoney(m(l.amount, l.currency)) })),
      lines_truncated: lines.length > MAX_PAYOUT_LINES,
    };
  }

  async statement(actor: Principal, storeId: string, q: StatementQuery): Promise<SellerStatement> {
    this.access(actor, "statement.read", storeId);
    const cur = this.d.currency;
    const RANGE = `r AS (SELECT (($1 || '-01')::date)::timestamp AT TIME ZONE 'Africa/Cairo' AS s, ((($1 || '-01')::date + interval '1 month')::timestamp) AT TIME ZONE 'Africa/Cairo' AS e)`;
    const { byKind, memo } = await this.store(storeId, async (tx) => ({
      byKind: (
        await tx.query<{ kind: string; opening: string; change: string }>(
          `WITH ${RANGE}
           SELECT e.kind,
                  COALESCE(SUM(CASE WHEN e.occurred_at < r.s THEN -p.amount_minor ELSE 0 END), 0)::text AS opening,
                  COALESCE(SUM(CASE WHEN e.occurred_at >= r.s AND e.occurred_at < r.e THEN -p.amount_minor ELSE 0 END), 0)::text AS change
             FROM r, ledger_accounts a
             JOIN postings p ON p.account_id = a.id
             JOIN journal_entries e ON e.id = p.entry_id
            WHERE a.market_id = $2 AND a.owner_type = 'store' AND a.owner_id = $3 AND a.currency = $4 AND a.type IN ('seller_pending', 'seller_available')
              AND e.occurred_at < r.e
            GROUP BY e.kind`,
          [q.month, this.d.marketId, storeId, cur],
        )
      ).rows,
      memo: (
        await tx.query<{ ps: string; pe: string; n: string; commission: string; vat: string; net: string }>(
          `WITH ${RANGE}
           SELECT to_char(r.s AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ps, to_char(r.e AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS pe,
                  m.n::text AS n, m.commission::text AS commission, m.vat::text AS vat, m.net::text AS net
             FROM r CROSS JOIN LATERAL (
               SELECT count(*) AS n, COALESCE(SUM(so.commission_minor), 0) AS commission, COALESCE(SUM(so.commission_vat_minor), 0) AS vat, COALESCE(SUM(so.seller_net_minor), 0) AS net
                 FROM seller_orders so
                WHERE so.store_id = $3::uuid AND so.currency = $4 AND EXISTS (
                  SELECT 1 FROM journal_entries e
                    JOIN postings p ON p.entry_id = e.id
                    JOIN ledger_accounts a ON a.id = p.account_id
                   WHERE e.kind = ANY($5::text[]) AND e.occurred_at >= r.s AND e.occurred_at < r.e
                     AND ((e.ref_type = 'order_group' AND e.ref_id = so.order_group_id::text) OR (e.ref_type = 'seller_order' AND e.ref_id = so.id::text))
                     AND a.type = 'seller_pending' AND a.owner_type = 'store' AND a.owner_id = $3::text AND a.market_id = $2)) m`,
          [q.month, this.d.marketId, storeId, cur, ORDER_KINDS],
        )
      ).rows[0],
    }));
    if (memo === undefined) throw Problems.internal("statement-range-missing");
    const sum = (kinds: readonly string[] | undefined, col: "opening" | "change"): bigint =>
      byKind.filter((r) => kinds === undefined || kinds.includes(r.kind)).reduce((s, r) => s + BigInt(r[col]), 0n);
    const opening = sum(undefined, "opening");
    const ordersNet = sum(ORDER_KINDS, "change");
    const refunds = sum(REFUND_KINDS, "change");
    const payouts = sum(PAYOUT_KINDS, "change");
    const netChange = sum(undefined, "change");
    const adjustments = netChange - ordersNet - refunds - payouts;
    const commission = BigInt(memo.commission);
    const commissionVat = BigInt(memo.vat);
    const w = (v: bigint) => wireMoney(money(v, cur));
    return {
      month: q.month,
      currency: cur,
      period_start: memo.ps,
      period_end: memo.pe,
      opening_balance: w(opening),
      closing_balance: w(opening + netChange),
      orders_count: Number(memo.n),
      orders_gross: w(ordersNet + commission + commissionVat),
      commission: w(commission),
      commission_vat: w(commissionVat),
      orders_net: w(ordersNet),
      refunds: w(refunds),
      adjustments: w(adjustments),
      payouts: w(payouts),
      net_change: w(netChange),
      eta_invoice: { status: "not_connected", url: null },
    };
  }
}
