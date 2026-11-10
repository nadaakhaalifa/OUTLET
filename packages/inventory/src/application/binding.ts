import { applyDbContext, contextSettings } from "@outlet/db";
import type { Queryable } from "@outlet/db";
import type { Env } from "./env.js";

const KEYS = Object.keys(contextSettings({ kind: "user", marketId: "x" }));

/**
 * Runs fn with the transaction re-bound to a store context (keeping the caller's user id), then restores every setting.
 * This is how the shopper path touches store-owned rows without any RLS exception (see migration 0013). On failure the
 * caller's savepoint / transaction rollback also reverts the settings (set_config(..., true) is transactional).
 */
export const inStoreContext = async <T>(env: Env, tx: Queryable, storeId: string, fn: () => Promise<T>): Promise<T> => {
  const saved = await tx.query<{ k: string; v: string | null }>("SELECT k, current_setting(k, true) AS v FROM unnest($1::text[]) AS k", [KEYS]);
  const userId = saved.rows.find((r) => r.k === "app.current_user_id")?.v ?? "";
  await applyDbContext(tx, { kind: "store", marketId: env.marketId, storeId, ...(userId !== "" ? { userId } : {}) });
  const out = await fn();
  await tx.query("SELECT set_config(k, v, true) FROM unnest($1::text[], $2::text[]) AS t(k, v)", [saved.rows.map((r) => r.k), saved.rows.map((r) => r.v ?? "")]);
  return out;
};
