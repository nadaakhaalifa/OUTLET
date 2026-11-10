import type { Queryable } from "@outlet/db";
import { UserNotFoundError } from "./errors.js";
import type { ConsentMethod, ConsentPurpose } from "./purposes.js";
import { CONSENT_PURPOSES } from "./purposes.js";
import { resolveDeps } from "./deps.js";
import type { PrivacyDeps, ResolvedDeps } from "./deps.js";

/** Versions of the consent wording per purpose. A new version may invalidate earlier grants (configurable). */
export interface ConsentTextRegistry {
  currentVersion(marketId: string, purpose: ConsentPurpose): number;
  /** True when a grant recorded under an older version no longer counts. */
  invalidatesOnNewVersion(purpose: ConsentPurpose): boolean;
}

export interface StaticRegistryConfig {
  /** purpose -> current text version (default 1). */
  readonly versions?: Readonly<Partial<Record<ConsentPurpose, number>>>;
  /** purposes whose old grants survive a new text version (default: none, i.e. all are invalidated). */
  readonly keepOldGrants?: readonly ConsentPurpose[];
}

export class StaticConsentRegistry implements ConsentTextRegistry {
  constructor(private readonly config: StaticRegistryConfig = {}) {}
  currentVersion(_marketId: string, purpose: ConsentPurpose): number {
    return this.config.versions?.[purpose] ?? 1;
  }
  invalidatesOnNewVersion(purpose: ConsentPurpose): boolean {
    return !(this.config.keepOldGrants?.includes(purpose) ?? false);
  }
}

export interface ConsentDecisionInput {
  readonly version?: number;
  readonly method: ConsentMethod;
  readonly ipHmac?: Uint8Array;
  readonly deviceId?: string;
}

export interface ConsentStatus {
  readonly purpose: ConsentPurpose;
  readonly granted: boolean;
  /** Version of the latest decision, or null if the user never decided. */
  readonly version: number | null;
  readonly recordedAt: Date | null;
  /** True when a grant exists but its wording version is outdated. */
  readonly stale: boolean;
}

interface LatestRow {
  purpose_code: ConsentPurpose;
  granted: boolean;
  purpose_version: number;
  recorded_at: Date;
}

export class ConsentService {
  private readonly d: ResolvedDeps;
  constructor(
    deps: PrivacyDeps,
    private readonly registry: ConsentTextRegistry = new StaticConsentRegistry(),
  ) {
    this.d = resolveDeps(deps);
  }

  grant(userId: string, purpose: ConsentPurpose, input: ConsentDecisionInput): Promise<void> {
    return this.record(userId, purpose, true, input);
  }

  withdraw(userId: string, purpose: ConsentPurpose, input: ConsentDecisionInput): Promise<void> {
    return this.record(userId, purpose, false, input);
  }

  /** Latest decision per purpose. A purpose the user never decided on is reported as not granted. */
  async current(userId: string): Promise<ConsentStatus[]> {
    return this.currentWith(this.d.db, userId);
  }

  async isGranted(userId: string, purpose: ConsentPurpose): Promise<boolean> {
    const all = await this.current(userId);
    return all.find((s) => s.purpose === purpose)?.granted ?? false;
  }

  private async currentWith(q: Queryable, userId: string): Promise<ConsentStatus[]> {
    const u = await q.query<{ market_id: string }>("SELECT market_id FROM users WHERE id = $1", [userId]);
    const marketId = u.rows[0]?.market_id;
    if (marketId === undefined) throw new UserNotFoundError(userId);
    const r = await q.query<LatestRow>(
      `SELECT DISTINCT ON (purpose_code) purpose_code, granted, purpose_version, recorded_at
         FROM consent_records WHERE user_id = $1
        ORDER BY purpose_code, recorded_at DESC, id DESC`,
      [userId],
    );
    const byPurpose = new Map(r.rows.map((x) => [x.purpose_code, x]));
    return CONSENT_PURPOSES.map((purpose): ConsentStatus => {
      const row = byPurpose.get(purpose);
      if (row === undefined) return { purpose, granted: false, version: null, recordedAt: null, stale: false };
      const outdated = this.registry.invalidatesOnNewVersion(purpose) && row.purpose_version < this.registry.currentVersion(marketId, purpose);
      return {
        purpose,
        granted: row.granted && !outdated,
        version: row.purpose_version,
        recordedAt: row.recorded_at,
        stale: row.granted && outdated,
      };
    });
  }

  private record(userId: string, purpose: ConsentPurpose, granted: boolean, input: ConsentDecisionInput): Promise<void> {
    return this.d.db.transaction(async (tx) => {
      const u = await tx.query<{ market_id: string }>("SELECT market_id FROM users WHERE id = $1", [userId]);
      const marketId = u.rows[0]?.market_id;
      if (marketId === undefined) throw new UserNotFoundError(userId);
      const version = input.version ?? this.registry.currentVersion(marketId, purpose);
      const at = this.d.now();
      await tx.query(
        `INSERT INTO consent_records (id, market_id, user_id, device_id, purpose_code, purpose_version, granted, method, ip_hmac, recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [this.d.newId(), marketId, userId, input.deviceId ?? null, purpose, version, granted, input.method, input.ipHmac ?? null, at],
      );
      await tx.query(
        `INSERT INTO consent_state (user_id, purpose_code, market_id, granted, purpose_version, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (user_id, purpose_code) DO UPDATE
           SET granted = EXCLUDED.granted, purpose_version = EXCLUDED.purpose_version, updated_at = EXCLUDED.updated_at`,
        [userId, purpose, marketId, granted, version, at],
      );
      await this.d.outbox.append(tx, {
        id: this.d.newId(),
        type: "consent.changed",
        aggregateType: "consent",
        aggregateId: userId,
        marketId,
        occurredAt: at.toISOString(),
        payload: { userId, purpose, granted, method: input.method, consentVersion: version },
      });
    });
  }
}
