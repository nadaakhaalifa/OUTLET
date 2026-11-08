import type { Queryable } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import type { Hasher } from "./crypto.js";

/** Idempotent on install id: the same install returns the same device id. */
export const registerDevice = async (
  db: Queryable,
  hasher: Hasher,
  input: { marketId: string; platform: "web" | "ios" | "android"; installId: string; now: Date },
): Promise<string> => {
  const ts = input.now.toISOString();
  const r = await db.query<{ id: string }>(
    `INSERT INTO devices (id, market_id, platform, install_id_hash, first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$5)
     ON CONFLICT (install_id_hash) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at
     RETURNING id`,
    [uuidv7(input.now.getTime()), input.marketId, input.platform, hasher.hmac("install", input.installId), ts],
  );
  const row = r.rows[0];
  if (!row) throw new Error("device upsert returned no row");
  return row.id;
};
