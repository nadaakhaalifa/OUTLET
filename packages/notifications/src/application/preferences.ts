import type { Queryable, SqlClient } from "@outlet/db";
import type { ConsentService } from "@outlet/privacy";
import { MARKETING_PURPOSE } from "../domain/types.js";
import type { Category, Channel } from "../domain/types.js";

export interface PreferenceRow {
  readonly channel: Channel;
  readonly category: Category;
  readonly enabled: boolean;
}

export class MarketingChannelUnsupportedError extends Error {
  constructor(readonly channel: Channel) {
    super(`channel ${channel} has no marketing consent purpose`);
    this.name = "MarketingChannelUnsupportedError";
  }
}

type ConsentWriter = Pick<ConsentService, "grant" | "withdraw">;

/**
 * Per-channel preferences for one shopper. Runs as the shopper (user context, outlet_app).
 * Withdrawal is one call: the marketing preference is switched off AND the matching consent purpose is withdrawn (B1, one tap).
 */
export class PreferencesService {
  constructor(
    private readonly db: SqlClient,
    private readonly consent: ConsentWriter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(userId: string): Promise<PreferenceRow[]> {
    const r = await this.db.query<PreferenceRow>("SELECT channel, category, enabled FROM notification_preferences WHERE user_id = $1 ORDER BY channel, category", [userId]);
    return r.rows;
  }

  /** Withdraws marketing on a channel: consent first (the source of truth), then the preference row. Idempotent. */
  async withdrawMarketing(userId: string, channel: Channel): Promise<void> {
    const purpose = MARKETING_PURPOSE[channel];
    if (purpose !== null) await this.consent.withdraw(userId, purpose, { method: "settings" });
    await this.upsert(userId, channel, "marketing", false);
  }

  /** Opts in to marketing on a channel: records the explicit consent, then the preference. SMS has no marketing purpose. */
  async enableMarketing(userId: string, channel: Channel): Promise<void> {
    const purpose = MARKETING_PURPOSE[channel];
    if (channel === "sms") throw new MarketingChannelUnsupportedError(channel);
    await this.upsert(userId, channel, "marketing", true);
    if (purpose !== null) await this.consent.grant(userId, purpose, { method: "settings" });
  }

  /** Mutes or unmutes a channel for transactional messages (the user's own choice; default is on). */
  setTransactional(userId: string, channel: Channel, enabled: boolean): Promise<void> {
    return this.upsert(userId, channel, "transactional", enabled);
  }

  private upsert(userId: string, channel: Channel, category: Category, enabled: boolean): Promise<void> {
    return this.db.transaction(async (tx: Queryable) => {
      const u = await tx.query<{ market_id: string }>("SELECT market_id FROM users WHERE id = $1", [userId]);
      const market = u.rows[0]?.market_id;
      if (market === undefined) throw new Error("user not found");
      await tx.query(
        `INSERT INTO notification_preferences (user_id, channel, category, market_id, enabled, updated_at) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (user_id, channel, category) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at`,
        [userId, channel, category, market, enabled, this.now().toISOString()],
      );
    });
  }
}
