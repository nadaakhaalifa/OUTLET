import { withDbContext } from "./context.js";
import type { Queryable, SqlClient } from "./sql.js";

export interface TenantContext {
  readonly marketId: string;
  /** Binds app.current_store_id (kind 'store'); omit for user-scoped work. */
  readonly storeId?: string;
  /** Binds app.current_user_id; omit for store-scoped work. */
  readonly userId?: string;
}

/**
 * Thin wrapper over withDbContext for the request path: kind 'store' when a storeId is given, else 'user'.
 * Settings are transaction-local; an omitted id is bound to '' (read as NULL), never inherited.
 */
export const withTenant = <T>(client: SqlClient, ctx: TenantContext, fn: (tx: Queryable) => Promise<T>): Promise<T> =>
  ctx.storeId !== undefined
    ? withDbContext(client, { kind: "store", marketId: ctx.marketId, storeId: ctx.storeId, ...(ctx.userId !== undefined ? { userId: ctx.userId } : {}) }, fn)
    : withDbContext(client, { kind: "user", marketId: ctx.marketId, ...(ctx.userId !== undefined ? { userId: ctx.userId } : {}) }, fn);
