import type { DbTx } from "../unit-of-work";

/**
 * REFERENCE REPOSITORY (copy the shape, not the table). Rules it demonstrates:
 *  - methods take the `DbTx`; they never open transactions or read the clock;
 *  - rows are mapped to plain domain-ish records, never leak Kysely types;
 *  - no WHERE clause re-implements authorization: RLS is the second layer, the
 *    route guard is the first (the repository still filters by subject so a
 *    policy gap cannot widen a read silently);
 *  - append-only table: insert only, withdrawal is a new row.
 */
export interface ConsentChange {
  readonly subjectType: "user" | "device";
  readonly subjectId: string;
  readonly purpose: string;
  readonly version: number;
  readonly granted: boolean;
  readonly method: "onboarding" | "settings" | "prompt" | "api";
  readonly ipHash: string | null;
  readonly at: Date;
}

export interface CurrentConsent {
  readonly purpose: string;
  readonly granted: boolean;
  readonly version: number;
  readonly since: Date;
}

export class KyselyConsentStore {
  public async append(tx: DbTx, c: ConsentChange): Promise<void> {
    await tx.db
      .insertInto("consent_records")
      .values({
        subject_type: c.subjectType,
        subject_id: c.subjectId,
        purpose: c.purpose,
        version: c.version,
        granted: c.granted,
        method: c.method,
        occurred_at: c.at,
        ip_hash: c.ipHash,
        app_version: null,
      })
      .execute();
  }

  /** Count of history rows visible to the caller for a subject (RLS decides visibility). */
  public async historyCount(tx: DbTx, subjectType: "user" | "device", subjectId: string): Promise<number> {
    const rows = await tx.db
      .selectFrom("consent_records")
      .select("id")
      .where("subject_type", "=", subjectType)
      .where("subject_id", "=", subjectId)
      .execute();
    return rows.length;
  }

  /** Latest decision per purpose. "No row" means not consented (never pre-ticked). */
  public async current(tx: DbTx, subjectType: "user" | "device", subjectId: string): Promise<readonly CurrentConsent[]> {
    const rows = await tx.db
      .selectFrom("consent_records")
      .select(["purpose", "granted", "version", "occurred_at", "seq"])
      .where("subject_type", "=", subjectType)
      .where("subject_id", "=", subjectId)
      .orderBy("seq", "desc")
      .execute();
    const seen = new Set<string>();
    const out: CurrentConsent[] = [];
    for (const r of rows) {
      if (seen.has(r.purpose)) continue;
      seen.add(r.purpose);
      out.push({ purpose: r.purpose, granted: r.granted, version: r.version, since: r.occurred_at });
    }
    return out;
  }
}
