import { withDbContext } from "@outlet/db";
import type { RoleSqlClient } from "@outlet/db";
import { decodeCursor, encodeCursor } from "../../platform/cursor.js";
import type { SessionReaderPort, SessionRow } from "./ports.js";

interface Row {
  id: string;
  device_id: string;
  platform: string;
  ua_family: string | null;
  amr: string[];
  created_at: Date;
  last_seen_at: Date | null;
}

export class SessionReader implements SessionReaderPort {
  constructor(private readonly client: RoleSqlClient<"outlet_app">, private readonly marketId: string) {}

  async list(userId: string, page: { readonly limit: number; readonly cursor?: string }): Promise<{ readonly items: readonly SessionRow[]; readonly nextCursor: string | null }> {
    const after = page.cursor === undefined ? undefined : decodeCursor(page.cursor, 2);
    const rows = await withDbContext(this.client, { kind: "user", marketId: this.marketId, userId }, async (tx) =>
      (
        await tx.query<Row>(
          `SELECT sf.id, sf.device_id, d.platform, d.ua_family, sf.amr, sf.created_at, d.last_seen_at
             FROM session_families sf JOIN devices d ON d.id = sf.device_id
            WHERE sf.user_id = $1 AND sf.revoked_at IS NULL
              AND ($2::timestamptz IS NULL OR (sf.created_at, sf.id) < ($2::timestamptz, $3::uuid))
            ORDER BY sf.created_at DESC, sf.id DESC LIMIT $4`,
          [userId, after?.[0] ?? null, after?.[1] ?? null, page.limit + 1],
        )
      ).rows,
    );
    const more = rows.length > page.limit;
    const items = rows.slice(0, page.limit);
    const last = items[items.length - 1];
    return {
      items: items.map((r): SessionRow => ({ id: r.id, deviceId: r.device_id, platform: r.platform, uaFamily: r.ua_family, amr: r.amr, createdAt: r.created_at, lastSeenAt: r.last_seen_at })),
      nextCursor: more && last !== undefined ? encodeCursor(last.created_at.toISOString(), last.id) : null,
    };
  }
}
