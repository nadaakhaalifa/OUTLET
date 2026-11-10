import { applyDbContext, contextSettings } from "@outlet/db";
import type { Queryable } from "@outlet/db";

const KEYS = Object.keys(contextSettings({ kind: "user", marketId: "x" }));

/**
 * Runs fn once per store with the transaction re-bound to that store's context (keeping the caller's user id), then restores
 * every setting. One save and one restore for all stores (query budget). Same trust model as @outlet/inventory: the store id
 * comes from the catalog line, never from a shopper-controlled filter.
 */
export const eachStoreContext = async <T>(tx: Queryable, marketId: string, storeIds: readonly string[], fn: (storeId: string) => Promise<T>): Promise<Map<string, T>> => {
  const out = new Map<string, T>();
  if (storeIds.length === 0) return out;
  const saved = await tx.query<{ k: string; v: string | null }>("SELECT k, current_setting(k, true) AS v FROM unnest($1::text[]) AS k", [KEYS]);
  const userId = saved.rows.find((r) => r.k === "app.current_user_id")?.v ?? "";
  for (const storeId of storeIds) {
    await applyDbContext(tx, { kind: "store", marketId, storeId, ...(userId !== "" ? { userId } : {}) });
    out.set(storeId, await fn(storeId));
  }
  await tx.query("SELECT set_config(k, v, true) FROM unnest($1::text[], $2::text[]) AS t(k, v)", [saved.rows.map((r) => r.k), saved.rows.map((r) => r.v ?? "")]);
  return out;
};
