import type { Queryable } from "@outlet/db";

/** Store roles that handle orders and so receive order notices (finance, catalog and support do not). */
export const ORDER_NOTICE_ROLES = ["owner", "manager", "warehouse"] as const;

/**
 * Resolves the users who receive a store-level notice. Runs inside the dispatcher's worker transaction (job `notifications.dispatch`).
 * store_members is store-isolated, so the worker reads it through the narrow policy `store_members__worker_notifications_dispatch`
 * (migration 0034: SELECT only, active rows, market pinned). The store is always an explicit predicate here, never ambient context.
 */
export interface StoreRecipientResolver {
  resolve(storeId: string, marketId: string, tx: Queryable): Promise<readonly string[]>;
}

export const pgStoreRecipients: StoreRecipientResolver = {
  resolve: async (storeId, marketId, tx) => {
    const r = await tx.query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM store_members
        WHERE store_id = $1 AND market_id = $2 AND status = 'active' AND user_id IS NOT NULL AND role_code = ANY($3::text[])
        ORDER BY user_id`,
      [storeId, marketId, [...ORDER_NOTICE_ROLES]],
    );
    return r.rows.map((x) => x.user_id);
  },
};
