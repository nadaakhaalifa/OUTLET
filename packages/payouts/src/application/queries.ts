import { withDbContext } from "@outlet/db";
import type { RoleSqlClient } from "@outlet/db";

export interface SellerPayoutView {
  readonly id: string;
  readonly status: string;
  readonly cycleStart: string;
  readonly cycleEnd: string;
  readonly grossMinor: bigint;
  readonly adjustmentsMinor: bigint;
  readonly netMinor: bigint;
  readonly currency: string;
  readonly sentAt: Date | null;
  readonly settledAt: Date | null;
}
export const MAX_PAYOUT_PAGE = 50;

/**
 * Seller finance page (P1-10l): the store's own payouts, newest first. Runs as outlet_app in the store context, so Postgres RLS
 * (payouts_store_isolation) is the guard: another store's payouts are invisible, not "forbidden". Internal columns (approval ids,
 * hold reasons, ledger entry ids, idempotency keys) are never selected.
 */
export async function listPayoutsForStore(client: RoleSqlClient<"outlet_app">, args: { readonly marketId: string; readonly storeId: string; readonly limit?: number }): Promise<SellerPayoutView[]> {
  const limit = Math.min(Math.max(args.limit ?? MAX_PAYOUT_PAGE, 1), MAX_PAYOUT_PAGE);
  return withDbContext(client, { kind: "store", marketId: args.marketId, storeId: args.storeId }, async (tx) => {
    const r = await tx.query<{ id: string; status: string; cycle_start: string; cycle_end: string; gross: string; adj: string; net: string; currency: string; sent_at: Date | null; settled_at: Date | null }>(
      `SELECT id, status, cycle_start::text AS cycle_start, cycle_end::text AS cycle_end, gross_minor::text AS gross, adjustments_minor::text AS adj, net_minor::text AS net, currency, sent_at, settled_at
         FROM payouts ORDER BY created_at DESC, id DESC LIMIT $1`,
      [limit],
    );
    return r.rows.map((x) => ({ id: x.id, status: x.status, cycleStart: x.cycle_start, cycleEnd: x.cycle_end, grossMinor: BigInt(x.gross), adjustmentsMinor: BigInt(x.adj), netMinor: BigInt(x.net), currency: x.currency, sentAt: x.sent_at, settledAt: x.settled_at }));
  });
}
