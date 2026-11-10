import type { SqlClient } from "@outlet/db";
import { assertNoKillSwitchRules } from "./kill-switches.js";
import { FlagRulesSchema } from "./types.js";
import type { FlagRecord, FlagStore, FlagWrite } from "./types.js";

interface Row {
  key: string;
  market_id: string | null;
  enabled: boolean;
  rules: unknown;
  version: number;
  updated_by: string;
  updated_at: Date | string;
}

const toRecord = (r: Row): FlagRecord => ({
  key: r.key,
  marketId: r.market_id,
  enabled: r.enabled,
  rules: FlagRulesSchema.parse(r.rules),
  version: r.version,
  updatedBy: r.updated_by,
  updatedAt: new Date(r.updated_at),
});

const COLS = "key, market_id, enabled, rules, version, updated_by, updated_at";

export class PostgresFlagStore implements FlagStore {
  constructor(private readonly db: SqlClient) {}

  async get(key: string, marketId: string): Promise<readonly FlagRecord[]> {
    const { rows } = await this.db.query<Row>(
      `SELECT ${COLS} FROM feature_flags WHERE key = $1 AND (market_id IS NULL OR market_id = $2)`,
      [key, marketId],
    );
    return rows.map(toRecord);
  }

  async list(): Promise<readonly FlagRecord[]> {
    const { rows } = await this.db.query<Row>(`SELECT ${COLS} FROM feature_flags ORDER BY key, market_id NULLS FIRST`);
    return rows.map(toRecord);
  }

  async put(w: FlagWrite): Promise<{ before: FlagRecord | undefined; after: FlagRecord }> {
    assertNoKillSwitchRules(w.key, w.rules);
    const rules = FlagRulesSchema.parse(w.rules ?? {});
    return this.db.transaction(async (tx) => {
      const prev = await tx.query<Row>(
        `SELECT ${COLS} FROM feature_flags WHERE key = $1 AND COALESCE(market_id, '') = COALESCE($2::text, '') FOR UPDATE`,
        [w.key, w.marketId],
      );
      const before = prev.rows[0] ? toRecord(prev.rows[0]) : undefined;
      const res = before
        ? await tx.query<Row>(
            `UPDATE feature_flags SET enabled = $3, rules = $4::jsonb, version = version + 1, updated_by = $5, updated_at = $6
             WHERE key = $1 AND COALESCE(market_id, '') = COALESCE($2::text, '') RETURNING ${COLS}`,
            [w.key, w.marketId, w.enabled, JSON.stringify(rules), w.updatedBy, w.updatedAt.toISOString()],
          )
        : await tx.query<Row>(
            `INSERT INTO feature_flags (${COLS}) VALUES ($1, $2, $3, $4::jsonb, 1, $5, $6) RETURNING ${COLS}`,
            [w.key, w.marketId, w.enabled, JSON.stringify(rules), w.updatedBy, w.updatedAt.toISOString()],
          );
      const row = res.rows[0];
      if (!row) throw new Error("feature_flags upsert returned no row");
      return { before, after: toRecord(row) };
    });
  }
}
