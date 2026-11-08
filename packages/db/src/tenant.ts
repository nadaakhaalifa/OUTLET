import type { Queryable, SqlClient } from "./sql.js";

export interface TenantContext {
  readonly marketId: string;
  /** Binds app.current_store_id; omit for user-scoped work. */
  readonly storeId?: string;
  /** Binds app.current_user_id; omit for store-scoped work. */
  readonly userId?: string;
}

/**
 * Runs fn in one transaction with the tenant bound via set_config(..., true)
 * (transaction-local, parameterised; the equivalent of SET LOCAL). The settings
 * disappear at commit or rollback, so pooled connections never leak a tenant.
 * An omitted id is bound to '' (read as NULL by app.current_*_id()), never inherited.
 */
export const withTenant = <T>(client: SqlClient, ctx: TenantContext, fn: (tx: Queryable) => Promise<T>): Promise<T> =>
  client.transaction(async (tx) => {
    await tx.query(
      "SELECT set_config('app.current_store_id', $1, true), set_config('app.current_market_id', $2, true), set_config('app.current_user_id', $3, true)",
      [ctx.storeId ?? "", ctx.marketId, ctx.userId ?? ""],
    );
    return fn(tx);
  });
