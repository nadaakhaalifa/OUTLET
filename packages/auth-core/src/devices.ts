import { contextClient } from "@outlet/db";
import type { SqlClient } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import type { Hasher } from "./crypto.js";

/**
 * Idempotent on install id: the same install returns the same device id. Pre-auth, so it runs in an auth
 * context keyed on the install hash: INSERT ... ON CONFLICT DO NOTHING (never DO UPDATE, which would need to
 * UPDATE a row that may already be bound to another user), then a lookup-policy SELECT. `last_seen_at` and the
 * user binding are written later by SessionService.issue, in the user context.
 */
export const registerDevice = async (
  db: SqlClient,
  hasher: Hasher,
  input: { marketId: string; platform: "web" | "ios" | "android"; installId: string; now: Date },
): Promise<string> => {
  const ts = input.now.toISOString();
  const installHash = hasher.hmac("install", input.installId);
  const scoped = contextClient(db, { kind: "auth", marketId: input.marketId, auth: { installHash: installHash.toString("hex") } });
  return scoped.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO devices (id, market_id, platform, install_id_hash, first_seen_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$5)
       ON CONFLICT (install_id_hash) DO NOTHING`,
      [uuidv7(input.now.getTime()), input.marketId, input.platform, installHash, ts],
    );
    const r = await tx.query<{ id: string }>("SELECT id FROM devices WHERE install_id_hash = $1 AND market_id = $2", [installHash, input.marketId]);
    const row = r.rows[0];
    if (!row) throw new Error("device register returned no row");
    return row.id;
  });
};
