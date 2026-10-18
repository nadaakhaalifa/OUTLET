import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { CONFLICT_OUTCOMES, EMAIL_LOCAL_PARTS, type ClaimView, type ConflictOutcome } from "../domain/bridge";
import {
  MARK_STATUSES,
  TRADEMARK_OFFICES,
  type BrandVerificationStore,
  type ClaimCandidateQuery,
  type ConflictRecord,
  type DomainVerificationRecord,
  type Effects,
  type IdGenerator,
  type NewConflict,
  type ReportRecord,
  type ResolveConflictStore,
  type ScreeningRecord,
  type TrademarkLookupRecord,
} from "../domain/ports";

/** Raw SQL with Zod-validated rows (same approach as ads, orders, budget). */
export type BrandVerificationDb = Kysely<Record<string, never>>;

const Ms = z.string().regex(/^-?\d+$/).transform((s) => Number(s));
const MsN = Ms.nullable();
const REASONS = z.enum(["same_name", "similar_name", "same_domain", "same_trademark"]);

const DomainRow = z.object({
  application_id: z.string(), applicant_id: z.string(), domain: z.string(), method: z.enum(["dns_txt", "email"]),
  status: z.enum(["pending", "verified", "failed", "expired"]), nonce: z.string(), email_local: z.enum(EMAIL_LOCAL_PARTS).nullable(),
  email_code_hash: z.string().nullable(), attempts: z.number().int(), expires_ms: Ms, verified_ms: MsN, version: z.number().int(),
  created_ms: Ms, updated_ms: Ms,
});
const ClaimRow = z.object({
  application_id: z.string(), applicant_id: z.string(), kind: z.enum(["local", "global"]), country: z.string(), brand_name_norm: z.string(),
  claim_domain: z.string().nullable(), trademark_key: z.string().nullable(), dv_ms: MsN, tm_ms: MsN, sub_ms: MsN,
});
const ConflictRow = z.object({
  id: z.string(), conflict_key: z.string(), application_ids: z.array(z.string()), reasons: z.array(REASONS),
  status: z.enum(["open", "resolved"]), outcome: z.enum(CONFLICT_OUTCOMES).nullable(), winner: z.string().nullable(),
  resolved_by: z.string().nullable(), resolved_ms: MsN, created_ms: Ms,
});
const LookupRow = z.object({
  id: z.string(), application_id: z.string(), source: z.enum(["registry", "manual"]), office: z.enum(TRADEMARK_OFFICES), register_number: z.string(),
  found: z.boolean(), owner_name: z.string().nullable(), mark_text: z.string().nullable(), classes: z.array(z.number()),
  mark_status: z.enum(MARK_STATUSES).nullable(), registered_on: z.string().nullable(), expires_on: z.string().nullable(),
  owner_score: z.number().int().nullable(), owner_band: z.enum(["match", "weak", "mismatch"]).nullable(), recorded_by: z.string().nullable(),
  retrieved_ms: Ms, created_ms: Ms,
});
const ScreeningRow = z.object({
  id: z.string(), application_id: z.string(), outcome: z.enum(["clear", "warn", "fail", "error"]), matched: z.array(z.string()),
  list_version: z.string(), screened_ms: Ms,
});

const ts = (ms: number) => sql`to_timestamp(${ms}::double precision / 1000.0)`;
const tsN = (ms: number | null) => (ms === null ? sql`null::timestamptz` : ts(ms));
const uuidArr = (ids: readonly string[]) =>
  sql`(select array_agg(x::uuid order by x) from jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) x)`;
const msOf = (col: string) => sql.raw(`(extract(epoch from ${col}) * 1000)::bigint::text`);

export class KyselyBrandVerificationStore implements BrandVerificationStore {
  constructor(
    private readonly db: BrandVerificationDb,
    private readonly ids: Pick<IdGenerator, "uuidV7">,
  ) {}

  private async tx<T>(fn: (t: BrandVerificationDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return fn(trx as unknown as BrandVerificationDb);
    });
  }

  private async effects(t: BrandVerificationDb, fx: Effects): Promise<void> {
    for (const e of fx.outbox) {
      await sql`insert into outbox_events (id, aggregate_type, aggregate_id, event_type, ordering_key, payload)
        values (${this.ids.uuidV7()}::uuid, 'brand_verification', ${e.aggregateId}::uuid, ${e.eventType},
                ${`brand_verification:${e.aggregateId}`}, ${JSON.stringify(e.payload)}::jsonb)`.execute(t);
    }
    for (const h of fx.history) {
      await sql`insert into bv_history (id, application_id, actor_id, action, ref_id)
        values (${this.ids.uuidV7()}::uuid, ${h.applicationId}::uuid, ${h.actorId}::uuid, ${h.action}, ${h.refId}::uuid)`.execute(t);
    }
  }

  private domainOf(r: z.infer<typeof DomainRow>): DomainVerificationRecord {
    return {
      applicationId: r.application_id, applicantId: r.applicant_id, domain: r.domain, method: r.method, status: r.status, nonce: r.nonce,
      emailLocal: r.email_local, emailCodeHash: r.email_code_hash, attempts: r.attempts, expiresAtMs: r.expires_ms, verifiedAtMs: r.verified_ms,
      version: r.version, createdAtMs: r.created_ms, updatedAtMs: r.updated_ms,
    };
  }

  async getDomainVerification(applicationId: string): Promise<DomainVerificationRecord | null> {
    return this.tx(async (t) => {
      const r = await sql<unknown>`select application_id::text, applicant_id::text, domain, method, status, nonce, email_local, email_code_hash,
        attempts, version, ${msOf("expires_at")} as expires_ms, ${msOf("verified_at")} as verified_ms,
        ${msOf("created_at")} as created_ms, ${msOf("updated_at")} as updated_ms
        from bv_domain_verifications where application_id = ${applicationId}::uuid`.execute(t);
      return r.rows[0] === undefined ? null : this.domainOf(DomainRow.parse(r.rows[0]));
    });
  }

  async saveDomainVerification(rec: DomainVerificationRecord, expected: number | null, fx: Effects): Promise<"saved" | "version_conflict"> {
    return this.tx(async (t) => {
      if (expected === null) {
        const r = await sql`insert into bv_domain_verifications (application_id, applicant_id, domain, method, status, nonce, email_local,
          email_code_hash, attempts, expires_at, verified_at, version, created_at, updated_at)
          values (${rec.applicationId}::uuid, ${rec.applicantId}::uuid, ${rec.domain}, ${rec.method}, ${rec.status}, ${rec.nonce}, ${rec.emailLocal},
          ${rec.emailCodeHash}, ${rec.attempts}, ${ts(rec.expiresAtMs)}, ${tsN(rec.verifiedAtMs)}, ${rec.version}, ${ts(rec.createdAtMs)}, ${ts(rec.updatedAtMs)})
          on conflict (application_id) do nothing returning application_id`.execute(t);
        if (r.rows.length === 0) return "version_conflict";
      } else {
        const r = await sql`update bv_domain_verifications set applicant_id = ${rec.applicantId}::uuid, domain = ${rec.domain}, method = ${rec.method},
          status = ${rec.status}, nonce = ${rec.nonce}, email_local = ${rec.emailLocal}, email_code_hash = ${rec.emailCodeHash}, attempts = ${rec.attempts},
          expires_at = ${ts(rec.expiresAtMs)}, verified_at = ${tsN(rec.verifiedAtMs)}, version = ${rec.version}, created_at = ${ts(rec.createdAtMs)},
          updated_at = ${ts(rec.updatedAtMs)} where application_id = ${rec.applicationId}::uuid and version = ${expected} returning application_id`.execute(t);
        if (r.rows.length === 0) return "version_conflict";
      }
      await this.effects(t, fx);
      return "saved";
    });
  }

  private claimSelect = sql.raw(`application_id::text, applicant_id::text, kind, country, brand_name_norm, claim_domain, trademark_key,
    ${"(extract(epoch from domain_verified_at) * 1000)::bigint::text"} as dv_ms,
    ${"(extract(epoch from trademark_matched_at) * 1000)::bigint::text"} as tm_ms,
    ${"(extract(epoch from submitted_at) * 1000)::bigint::text"} as sub_ms`);

  private claimOf(r: z.infer<typeof ClaimRow>): ClaimView {
    return {
      applicationId: r.application_id, applicantId: r.applicant_id, kind: r.kind, country: r.country, brandNameNorm: r.brand_name_norm,
      domain: r.claim_domain, trademarkKey: r.trademark_key, domainVerifiedAtMs: r.dv_ms, trademarkMatchedAtMs: r.tm_ms, submittedAtMs: r.sub_ms,
    };
  }

  async getClaim(applicationId: string): Promise<ClaimView | null> {
    return this.tx(async (t) => {
      const r = await sql<unknown>`select ${this.claimSelect} from bv_claims where application_id = ${applicationId}::uuid`.execute(t);
      return r.rows[0] === undefined ? null : this.claimOf(ClaimRow.parse(r.rows[0]));
    });
  }

  async upsertClaim(c: ClaimView): Promise<void> {
    await this.tx(async (t) => {
      await sql`insert into bv_claims (application_id, applicant_id, kind, country, brand_name_norm, claim_domain, trademark_key,
        domain_verified_at, trademark_matched_at, submitted_at, updated_at)
        values (${c.applicationId}::uuid, ${c.applicantId}::uuid, ${c.kind}, ${c.country}, ${c.brandNameNorm}, ${c.domain}, ${c.trademarkKey},
        ${tsN(c.domainVerifiedAtMs)}, ${tsN(c.trademarkMatchedAtMs)}, ${tsN(c.submittedAtMs)}, now())
        on conflict (application_id) do update set applicant_id = excluded.applicant_id, kind = excluded.kind, country = excluded.country,
        brand_name_norm = excluded.brand_name_norm, claim_domain = excluded.claim_domain, trademark_key = excluded.trademark_key,
        domain_verified_at = excluded.domain_verified_at, trademark_matched_at = excluded.trademark_matched_at,
        submitted_at = excluded.submitted_at, updated_at = now()`.execute(t);
    });
  }

  async findClaimCandidates(q: ClaimCandidateQuery): Promise<readonly ClaimView[]> {
    return this.tx(async (t) => {
      const r = await sql<unknown>`select ${this.claimSelect} from bv_claims
        where application_id <> ${q.exceptApplicationId}::uuid
          and (country = ${q.country} or (${q.domain}::text is not null and claim_domain = ${q.domain})
               or (${q.trademarkKey}::text is not null and trademark_key = ${q.trademarkKey}))
        order by application_id limit 500`.execute(t);
      return r.rows.map((x) => this.claimOf(ClaimRow.parse(x)));
    });
  }

  private conflictSelect = sql.raw(`id::text, conflict_key, to_jsonb(application_ids) as application_ids, to_jsonb(reasons) as reasons, status,
    outcome, winner_application_id::text as winner, resolved_by::text as resolved_by,
    (extract(epoch from resolved_at) * 1000)::bigint::text as resolved_ms, (extract(epoch from created_at) * 1000)::bigint::text as created_ms`);

  private conflictOf(r: z.infer<typeof ConflictRow>): ConflictRecord {
    return {
      id: r.id, conflictKey: r.conflict_key, applicationIds: r.application_ids, reasons: r.reasons, status: r.status, outcome: r.outcome,
      winnerApplicationId: r.winner, resolvedBy: r.resolved_by, resolvedAtMs: r.resolved_ms, createdAtMs: r.created_ms,
    };
  }

  async openConflict(c: NewConflict, fx: Effects): Promise<{ conflict: ConflictRecord; created: boolean }> {
    return this.tx(async (t) => {
      const ids = [...c.applicationIds].sort();
      const key = ids.join("|");
      const ins = await sql`insert into bv_claim_conflicts (id, conflict_key, application_ids, reasons, status, created_at)
        values (${c.id}::uuid, ${key}, ${uuidArr(ids)}, ${sql`(select array_agg(x order by x) from (select distinct jsonb_array_elements_text(${JSON.stringify(c.reasons)}::jsonb) x) d)`},
        'open', ${ts(c.createdAtMs)}) on conflict (conflict_key) do nothing returning id`.execute(t);
      const created = ins.rows.length > 0;
      if (created) await this.effects(t, fx);
      else {
        const cur = await sql<unknown>`select ${this.conflictSelect} from bv_claim_conflicts where conflict_key = ${key} for update`.execute(t);
        const existing = this.conflictOf(ConflictRow.parse(cur.rows[0]));
        if (existing.status === "open") {
          const merged = [...new Set([...existing.reasons, ...c.reasons])].sort();
          await sql`update bv_claim_conflicts set reasons = (select array_agg(x order by x) from jsonb_array_elements_text(${JSON.stringify(merged)}::jsonb) x)
            where conflict_key = ${key}`.execute(t);
        }
      }
      const r = await sql<unknown>`select ${this.conflictSelect} from bv_claim_conflicts where conflict_key = ${key}`.execute(t);
      return { conflict: this.conflictOf(ConflictRow.parse(r.rows[0])), created };
    });
  }

  async listConflictsFor(applicationId: string): Promise<readonly ConflictRecord[]> {
    return this.tx(async (t) => {
      const r = await sql<unknown>`select ${this.conflictSelect} from bv_claim_conflicts where application_ids @> array[${applicationId}::uuid] order by created_at, id`.execute(t);
      return r.rows.map((x) => this.conflictOf(ConflictRow.parse(x)));
    });
  }

  async resolveConflict(i: { id: string; outcome: ConflictOutcome; winnerApplicationId: string | null; resolvedBy: string; atMs: number }, fx: Effects): Promise<ResolveConflictStore> {
    return this.tx(async (t) => {
      const cur = await sql<unknown>`select ${this.conflictSelect} from bv_claim_conflicts where id = ${i.id}::uuid for update`.execute(t);
      if (cur.rows[0] === undefined) return { kind: "not_found" } as const;
      const existing = this.conflictOf(ConflictRow.parse(cur.rows[0]));
      if (existing.status === "resolved") return { kind: "already_resolved", conflict: existing } as const;
      await sql`update bv_claim_conflicts set status = 'resolved', outcome = ${i.outcome}, winner_application_id = ${i.winnerApplicationId}::uuid,
        resolved_by = ${i.resolvedBy}::uuid, resolved_at = ${ts(i.atMs)} where id = ${i.id}::uuid`.execute(t);
      await this.effects(t, fx);
      const r = await sql<unknown>`select ${this.conflictSelect} from bv_claim_conflicts where id = ${i.id}::uuid`.execute(t);
      return { kind: "resolved", conflict: this.conflictOf(ConflictRow.parse(r.rows[0])) } as const;
    });
  }

  private lookupSelect = sql.raw(`id::text, application_id::text, source, office, register_number, found, owner_name, mark_text,
    to_jsonb(mark_classes) as classes, mark_status, registered_on::text, expires_on::text, owner_score, owner_band, recorded_by::text,
    (extract(epoch from retrieved_at) * 1000)::bigint::text as retrieved_ms, (extract(epoch from created_at) * 1000)::bigint::text as created_ms`);

  async insertTrademarkLookup(r: TrademarkLookupRecord, fx: Effects): Promise<void> {
    await this.tx(async (t) => {
      await sql`insert into bv_trademark_lookups (id, application_id, source, office, register_number, found, owner_name, mark_text, mark_classes,
        mark_status, registered_on, expires_on, owner_score, owner_band, recorded_by, retrieved_at, created_at)
        values (${r.id}::uuid, ${r.applicationId}::uuid, ${r.source}, ${r.office}, ${r.registerNumber}, ${r.found}, ${r.ownerName}, ${r.markText},
        ${sql`(select coalesce(array_agg(x::int), '{}'::int[]) from jsonb_array_elements_text(${JSON.stringify(r.classes)}::jsonb) x)`},
        ${r.status}, ${r.registeredOn}::date, ${r.expiresOn}::date, ${r.ownerScore}, ${r.ownerBand}, ${r.recordedBy}::uuid, ${ts(r.retrievedAtMs)}, ${ts(r.createdAtMs)})`.execute(t);
      await this.effects(t, fx);
    });
  }

  async listTrademarkLookups(applicationId: string): Promise<readonly TrademarkLookupRecord[]> {
    return this.tx(async (t) => {
      const res = await sql<unknown>`select ${this.lookupSelect} from bv_trademark_lookups where application_id = ${applicationId}::uuid order by created_at, id`.execute(t);
      return res.rows.map((x) => {
        const r = LookupRow.parse(x);
        return {
          id: r.id, applicationId: r.application_id, source: r.source, office: r.office, registerNumber: r.register_number, found: r.found,
          ownerName: r.owner_name, markText: r.mark_text, classes: r.classes, status: r.mark_status, registeredOn: r.registered_on, expiresOn: r.expires_on,
          ownerScore: r.owner_score, ownerBand: r.owner_band, recordedBy: r.recorded_by, retrievedAtMs: r.retrieved_ms, createdAtMs: r.created_ms,
        };
      });
    });
  }

  async insertScreening(s: ScreeningRecord): Promise<void> {
    await this.tx(async (t) => {
      await sql`insert into bv_screenings (id, application_id, outcome, matched_list_ids, list_version, screened_at)
        values (${s.id}::uuid, ${s.applicationId}::uuid, ${s.outcome},
        ${sql`(select coalesce(array_agg(x), '{}'::text[]) from jsonb_array_elements_text(${JSON.stringify(s.matchedListIds)}::jsonb) x)`},
        ${s.listVersion}, ${ts(s.screenedAtMs)})`.execute(t);
    });
  }

  async latestScreening(applicationId: string): Promise<ScreeningRecord | null> {
    return this.tx(async (t) => {
      const res = await sql<unknown>`select id::text, application_id::text, outcome, to_jsonb(matched_list_ids) as matched, list_version,
        (extract(epoch from screened_at) * 1000)::bigint::text as screened_ms from bv_screenings
        where application_id = ${applicationId}::uuid order by created_at desc, id desc limit 1`.execute(t);
      if (res.rows[0] === undefined) return null;
      const r = ScreeningRow.parse(res.rows[0]);
      return { id: r.id, applicationId: r.application_id, outcome: r.outcome, matchedListIds: r.matched, listVersion: r.list_version, screenedAtMs: r.screened_ms };
    });
  }

  async insertReport(r: ReportRecord, fx: Effects): Promise<void> {
    await this.tx(async (t) => {
      await sql`insert into bv_auto_check_reports (id, application_id, risk, dual_approval_required, report, created_at)
        values (${r.id}::uuid, ${r.applicationId}::uuid, ${r.report.risk}, ${r.report.dualApprovalRequired}, ${JSON.stringify(r.report)}::jsonb, ${ts(r.createdAtMs)})`.execute(t);
      await this.effects(t, fx);
    });
  }

  async latestReport(applicationId: string): Promise<ReportRecord | null> {
    return this.tx(async (t) => {
      const res = await sql<{ id: string; created_ms: string; report: unknown }>`select id::text, report,
        (extract(epoch from created_at) * 1000)::bigint::text as created_ms from bv_auto_check_reports
        where application_id = ${applicationId}::uuid order by created_at desc, id desc limit 1`.execute(t);
      const row = res.rows[0];
      return row === undefined ? null : { id: row.id, applicationId, report: row.report as ReportRecord["report"], createdAtMs: Number(row.created_ms) };
    });
  }
}
