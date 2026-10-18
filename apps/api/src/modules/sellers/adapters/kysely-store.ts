import { sellers } from "@outlet/domain";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type {
  AggregateRow,
  ApplicationRow,
  BrandApplicationRepository,
  Commit,
  CommitResult,
  Cursor,
  DocumentRow,
  HistoryDraft,
  HistoryRow,
  OutboxEventDraft,
  Page,
  RepoScope,
  ReviewQueueQuery,
} from "../domain/ports";

/** Raw SQL, rows validated with Zod (same approach as orders). */
export type SellersDb = Kysely<Record<string, never>>;

const Ms = z.string().regex(/^-?\d+$/).transform((s) => Number(s));
const Bytes = z.custom<Uint8Array>((v) => v instanceof Uint8Array).transform((v) => new Uint8Array(v));
const MAX_DATE_MS = 253_402_300_799_999;
const iso = (ms: number): string => new Date(Math.min(Math.max(ms, 0), MAX_DATE_MS)).toISOString();
const isoOrNull = (ms: number | null): string | null => (ms === null ? null : iso(ms));
const buf = (b: Uint8Array | null): Buffer | null => (b === null ? null : Buffer.from(b));
const ms = (col: string): string => `floor(extract(epoch from ${col}) * 1000)::text`;

const ItemSchema = z.object({
  code: z.string(),
  kind: z.enum(sellers.REQUESTED_ITEM_KINDS),
  message_ar: z.string(),
  message_en: z.string(),
  satisfied: z.boolean(),
});
const DvSchema = z.object({
  method: z.enum(["dns_txt", "email"]),
  domain: z.string(),
  status: z.enum(["pending", "verified", "failed", "expired"]),
  txt_record_name: z.string().optional(),
  txt_record_value: z.string().optional(),
  email_sent_to_masked: z.string().optional(),
  expires_at_ms: z.number().optional(),
  verified_at_ms: z.number().nullable(),
});

const AppDb = z.object({
  id: z.string(),
  applicant_id: z.string(),
  status: z.enum(sellers.APPLICATION_STATUSES),
  version: z.number().int(),
  brand_kind: z.enum(sellers.BRAND_KINDS),
  country: z.string(),
  brand_name: z.string(),
  brand_name_norm: z.string(),
  ownership_basis: z.enum(sellers.OWNERSHIP_BASES).nullable(),
  trademark_register: z.string().nullable(),
  trademark_number: z.string().nullable(),
  trademark_owner_name: z.string().nullable(),
  commercial_register_no: z.string().nullable(),
  tax_card_no: z.string().nullable(),
  company_reg_no: z.string().nullable(),
  company_reg_country: z.string().nullable(),
  vat_or_tax_id: z.string().nullable(),
  website_domain: z.string().nullable(),
  social_handles: z.record(z.string(), z.string()),
  eta_registration: z.string().nullable(),
  description_ar: z.string().nullable(),
  description_en: z.string().nullable(),
  acknowledgements: z.record(z.string(), z.union([z.string(), z.boolean()])),
  pii_enc: Bytes.nullable(),
  national_id_enc: Bytes.nullable(),
  national_id_blind: Bytes.nullable(),
  domain_verification: DvSchema.nullable(),
  appeal_used: z.boolean(),
  appeal_statement: z.string().nullable(),
  submitted_ms: Ms.nullable(),
  decision: z.enum(sellers.DECISIONS).nullable(),
  decision_reason_code: z.enum(sellers.DECISION_REASON_CODES).nullable(),
  decision_message_ar: z.string().nullable(),
  decision_message_en: z.string().nullable(),
  decided_ms: Ms.nullable(),
  reapply_after_ms: Ms.nullable(),
  appeal_allowed: z.boolean(),
  decision_due_ms: Ms.nullable(),
  rejected_ms: Ms.nullable(),
  store_id: z.string().nullable(),
  assignee_id: z.string().nullable(),
  claimed_ms: Ms.nullable(),
  requested_items: z.array(ItemSchema),
  requested_ms: Ms.nullable(),
  created_ms: Ms,
  updated_ms: Ms,
});
const DocDb = z.object({
  id: z.string(),
  application_id: z.string(),
  applicant_id: z.string(),
  requirement_code: z.string(),
  original_filename_enc: Bytes.nullable(),
  content_type: z.enum(sellers.DOCUMENT_CONTENT_TYPES),
  size_bytes: z.number().int(),
  sha256: z.string(),
  object_key: z.string(),
  upload_status: z.enum(sellers.UPLOAD_STATUSES),
  scan_status: z.enum(sellers.SCAN_STATUSES),
  review_status: z.enum(sellers.REVIEW_STATUSES),
  review_note_public: z.string().nullable(),
  review_note_internal: z.string().nullable(),
  created_ms: Ms,
  uploaded_ms: Ms.nullable(),
});
const HistDb = z.object({
  id: z.string(),
  application_id: z.string(),
  from_status: z.enum(sellers.APPLICATION_STATUSES),
  to_status: z.enum(sellers.APPLICATION_STATUSES),
  event: z.string(),
  actor_type: z.enum(["APPLICANT", "SYSTEM", "ADMIN"]),
  actor_id: z.string().nullable(),
  reason_code: z.string().nullable(),
  occurred_ms: Ms,
});

const APP_COLS = sql.raw(`
  id::text as id, applicant_id::text as applicant_id, status, version, brand_kind, country::text as country, brand_name,
  brand_name_norm, ownership_basis, trademark_register, trademark_number, trademark_owner_name, commercial_register_no,
  tax_card_no, company_reg_no, company_reg_country::text as company_reg_country, vat_or_tax_id, website_domain, social_handles,
  eta_registration, description_ar, description_en, acknowledgements, pii_enc, national_id_enc, national_id_blind,
  domain_verification, appeal_used, appeal_statement, ${ms("submitted_at")} as submitted_ms, decision, decision_reason_code,
  decision_message_ar, decision_message_en, ${ms("decided_at")} as decided_ms, ${ms("reapply_after")} as reapply_after_ms,
  appeal_allowed, ${ms("decision_due_at")} as decision_due_ms, ${ms("rejected_at")} as rejected_ms, store_id::text as store_id,
  assignee_id::text as assignee_id, ${ms("claimed_at")} as claimed_ms, requested_items, ${ms("requested_at")} as requested_ms,
  ${ms("created_at")} as created_ms, ${ms("updated_at")} as updated_ms`);
const DOC_COLS = sql.raw(`
  id::text as id, application_id::text as application_id, applicant_id::text as applicant_id, requirement_code,
  original_filename_enc, content_type, size_bytes, sha256, object_key, upload_status, scan_status, review_status,
  review_note_public, review_note_internal, ${ms("created_at")} as created_ms, ${ms("uploaded_at")} as uploaded_ms`);

type Db = z.infer<typeof AppDb>;

function toRow(r: Db): ApplicationRow {
  const dv = r.domain_verification;
  return {
    id: r.id, applicantId: r.applicant_id, status: r.status, version: r.version, brandKind: r.brand_kind, country: r.country,
    brandName: r.brand_name, brandNameNorm: r.brand_name_norm, ownershipBasis: r.ownership_basis, trademarkRegister: r.trademark_register,
    trademarkNumber: r.trademark_number, trademarkOwnerName: r.trademark_owner_name, commercialRegisterNo: r.commercial_register_no,
    taxCardNo: r.tax_card_no, companyRegNo: r.company_reg_no, companyRegCountry: r.company_reg_country, vatOrTaxId: r.vat_or_tax_id,
    websiteDomain: r.website_domain, socialHandles: r.social_handles, etaRegistration: r.eta_registration,
    descriptionAr: r.description_ar, descriptionEn: r.description_en, acknowledgements: r.acknowledgements, piiEnc: r.pii_enc,
    nationalIdEnc: r.national_id_enc, nationalIdBlind: r.national_id_blind,
    domainVerification:
      dv === null
        ? null
        : {
            method: dv.method, domain: dv.domain, status: dv.status, verifiedAtMs: dv.verified_at_ms,
            ...(dv.txt_record_name !== undefined ? { txtRecordName: dv.txt_record_name } : {}),
            ...(dv.txt_record_value !== undefined ? { txtRecordValue: dv.txt_record_value } : {}),
            ...(dv.email_sent_to_masked !== undefined ? { emailSentToMasked: dv.email_sent_to_masked } : {}),
            ...(dv.expires_at_ms !== undefined ? { expiresAtMs: dv.expires_at_ms } : {}),
          },
    appealUsed: r.appeal_used, appealStatement: r.appeal_statement, submittedAtMs: r.submitted_ms,
    decision:
      r.decision === null || r.decision_reason_code === null || r.decided_ms === null
        ? null
        : {
            decision: r.decision, reasonCode: r.decision_reason_code, messageAr: r.decision_message_ar ?? "", messageEn: r.decision_message_en ?? "",
            decidedAtMs: r.decided_ms, reapplyAfterMs: r.reapply_after_ms, appealAllowed: r.appeal_allowed,
          },
    decisionDueAtMs: r.decision_due_ms, rejectedAtMs: r.rejected_ms, storeId: r.store_id, assigneeId: r.assignee_id, claimedAtMs: r.claimed_ms,
    requestedItems: r.requested_items.map((i) => ({ code: i.code, kind: i.kind, messageAr: i.message_ar, messageEn: i.message_en, satisfied: i.satisfied })),
    requestedAtMs: r.requested_ms, createdAtMs: r.created_ms, updatedAtMs: r.updated_ms,
  };
}

const toDoc = (r: z.infer<typeof DocDb>): DocumentRow => ({
  id: r.id, applicationId: r.application_id, applicantId: r.applicant_id, requirementCode: r.requirement_code,
  originalFilenameEnc: r.original_filename_enc, contentType: r.content_type, sizeBytes: r.size_bytes, sha256: r.sha256,
  objectKey: r.object_key, uploadStatus: r.upload_status, scanStatus: r.scan_status, reviewStatus: r.review_status,
  reviewNotePublic: r.review_note_public, reviewNoteInternal: r.review_note_internal, createdAtMs: r.created_ms, uploadedAtMs: r.uploaded_ms,
});

const itemsJson = (row: ApplicationRow): string =>
  JSON.stringify(row.requestedItems.map((i) => ({ code: i.code, kind: i.kind, message_ar: i.messageAr, message_en: i.messageEn, satisfied: i.satisfied })));
const dvJson = (row: ApplicationRow): string | null => {
  const d = row.domainVerification;
  return d === null
    ? null
    : JSON.stringify({
        method: d.method, domain: d.domain, status: d.status, txt_record_name: d.txtRecordName, txt_record_value: d.txtRecordValue,
        email_sent_to_masked: d.emailSentToMasked, expires_at_ms: d.expiresAtMs, verified_at_ms: d.verifiedAtMs,
      });
};

/** Only the one-active-application index maps to duplicate_active; any other unique violation is a real error. */
const isUniqueViolation = (e: unknown): boolean =>
  typeof e === "object" && e !== null && "code" in e && (e as { code?: unknown }).code === "23505" &&
  ((e as { constraint?: unknown }).constraint === "brand_applications_one_active_uq" ||
    (e instanceof Error && e.message.includes("brand_applications_one_active_uq")));

/** Raise to the platform role for bookkeeping tenants may not write directly (outbox), after the actor was authorised. */
const raiseToSystem = async (trx: SellersDb): Promise<void> => {
  await sql`select set_config('app.role', 'system', true)`.execute(trx);
};

/**
 * Postgres adapter. Each call is ONE transaction that drops to `app_user` and sets the caller's RLS identity
 * (role `seller` + user id for an applicant, `system` for the platform), so applicant isolation is enforced by
 * the database. State, documents, history and outbox events are written in the same transaction (A2.7).
 */
export class KyselyBrandApplicationRepository implements BrandApplicationRepository {
  constructor(
    private readonly db: SellersDb,
    private readonly applicationRole: string | null = "app_user",
  ) {}

  private async tx<T>(scope: RepoScope, run: (trx: SellersDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      const t = trx as unknown as SellersDb;
      if (this.applicationRole !== null) {
        if (!/^[a-z_][a-z0-9_]*$/.test(this.applicationRole)) throw new RangeError("invalid role name");
        await sql`SET LOCAL ROLE ${sql.id(this.applicationRole)}`.execute(t);
      }
      const role = scope.kind === "system" ? "system" : "seller";
      const userId = scope.kind === "system" ? "" : scope.applicantId;
      await sql`select set_config('app.role', ${role}, true), set_config('app.user_id', ${userId}, true),
                       set_config('app.store_ids', '', true)`.execute(t);
      return run(t);
    });
  }

  private static async event(trx: SellersDb, e: OutboxEventDraft): Promise<void> {
    await sql`
      insert into outbox_events (id, occurred_at, aggregate_type, aggregate_id, event_type, ordering_key, payload)
      values (${e.id}::uuid, ${iso(e.occurredAtMs)}::timestamptz, 'brand_application', ${e.aggregateId}::uuid,
              ${e.type}, ${`brand_application:${e.aggregateId}`}, ${JSON.stringify(e.payload)}::jsonb)`.execute(trx);
  }

  private static async history(trx: SellersDb, applicationId: string, applicantId: string, h: HistoryDraft): Promise<void> {
    await sql`
      insert into brand_application_history (id, application_id, applicant_id, from_status, to_status, event, actor_type, actor_id, reason_code, occurred_at)
      values (${h.id}::uuid, ${applicationId}::uuid, ${applicantId}::uuid, ${h.fromStatus}, ${h.toStatus}, ${h.event}, ${h.actorType},
              ${h.actorId}::uuid, ${h.reasonCode}, ${iso(h.occurredAtMs)}::timestamptz)`.execute(trx);
  }

  private static async upsertDoc(trx: SellersDb, d: DocumentRow): Promise<void> {
    await sql`
      insert into brand_application_documents (id, application_id, applicant_id, requirement_code, original_filename_enc, content_type, size_bytes,
        sha256, object_key, upload_status, scan_status, review_status, review_note_public, review_note_internal, created_at, uploaded_at)
      values (${d.id}::uuid, ${d.applicationId}::uuid, ${d.applicantId}::uuid, ${d.requirementCode}, ${buf(d.originalFilenameEnc)}, ${d.contentType},
        ${d.sizeBytes}, ${d.sha256}, ${d.objectKey}, ${d.uploadStatus}, ${d.scanStatus}, ${d.reviewStatus}, ${d.reviewNotePublic},
        ${d.reviewNoteInternal}, ${iso(d.createdAtMs)}::timestamptz, ${isoOrNull(d.uploadedAtMs)}::timestamptz)
      on conflict (id) do update set upload_status = excluded.upload_status, scan_status = excluded.scan_status,
        review_status = excluded.review_status, review_note_public = excluded.review_note_public,
        review_note_internal = excluded.review_note_internal, uploaded_at = excluded.uploaded_at`.execute(trx);
  }

  private static async writeApp(trx: SellersDb, a: ApplicationRow, mode: "insert" | { expected: number }): Promise<number> {
    const d = a.decision;
    const common = sql`
      ${a.applicantId}::uuid, ${a.status}, ${a.version}, ${a.brandKind}, ${a.country}, ${a.brandName}, ${a.brandNameNorm}, ${a.ownershipBasis},
      ${a.trademarkRegister}, ${a.trademarkNumber}, ${a.trademarkOwnerName}, ${a.commercialRegisterNo}, ${a.taxCardNo}, ${a.companyRegNo},
      ${a.companyRegCountry}, ${a.vatOrTaxId}, ${a.websiteDomain}, ${JSON.stringify(a.socialHandles)}::jsonb, ${a.etaRegistration},
      ${a.descriptionAr}, ${a.descriptionEn}, ${JSON.stringify(a.acknowledgements)}::jsonb, ${buf(a.piiEnc)}, ${buf(a.nationalIdEnc)},
      ${buf(a.nationalIdBlind)}, ${dvJson(a)}::jsonb, ${a.appealUsed}, ${a.appealStatement}, ${isoOrNull(a.submittedAtMs)}::timestamptz,
      ${d?.decision ?? null}, ${d?.reasonCode ?? null}, ${d?.messageAr ?? null}, ${d?.messageEn ?? null}, ${isoOrNull(d?.decidedAtMs ?? null)}::timestamptz,
      ${isoOrNull(d?.reapplyAfterMs ?? null)}::timestamptz, ${d?.appealAllowed ?? false}, ${isoOrNull(a.decisionDueAtMs)}::timestamptz,
      ${isoOrNull(a.rejectedAtMs)}::timestamptz, ${a.storeId}::uuid, ${a.assigneeId}::uuid, ${isoOrNull(a.claimedAtMs)}::timestamptz,
      ${itemsJson(a)}::jsonb, ${isoOrNull(a.requestedAtMs)}::timestamptz`;
    if (mode === "insert") {
      await sql`
        insert into brand_applications (id, applicant_id, status, version, brand_kind, country, brand_name, brand_name_norm, ownership_basis,
          trademark_register, trademark_number, trademark_owner_name, commercial_register_no, tax_card_no, company_reg_no, company_reg_country,
          vat_or_tax_id, website_domain, social_handles, eta_registration, description_ar, description_en, acknowledgements, pii_enc,
          national_id_enc, national_id_blind, domain_verification, appeal_used, appeal_statement, submitted_at, decision, decision_reason_code,
          decision_message_ar, decision_message_en, decided_at, reapply_after, appeal_allowed, decision_due_at, rejected_at, store_id, assignee_id,
          claimed_at, requested_items, requested_at, created_at, updated_at)
        values (${a.id}::uuid, ${common}, ${iso(a.createdAtMs)}::timestamptz, ${iso(a.updatedAtMs)}::timestamptz)`.execute(trx);
      return 1;
    }
    const r = await sql`
      update brand_applications set
        status = ${a.status}, version = ${a.version}, brand_kind = ${a.brandKind}, country = ${a.country}, brand_name = ${a.brandName},
        brand_name_norm = ${a.brandNameNorm}, ownership_basis = ${a.ownershipBasis}, trademark_register = ${a.trademarkRegister},
        trademark_number = ${a.trademarkNumber}, trademark_owner_name = ${a.trademarkOwnerName},
        commercial_register_no = ${a.commercialRegisterNo}, tax_card_no = ${a.taxCardNo}, company_reg_no = ${a.companyRegNo},
        company_reg_country = ${a.companyRegCountry}, vat_or_tax_id = ${a.vatOrTaxId}, website_domain = ${a.websiteDomain},
        social_handles = ${JSON.stringify(a.socialHandles)}::jsonb, eta_registration = ${a.etaRegistration},
        description_ar = ${a.descriptionAr}, description_en = ${a.descriptionEn},
        acknowledgements = ${JSON.stringify(a.acknowledgements)}::jsonb, pii_enc = ${buf(a.piiEnc)},
        national_id_enc = ${buf(a.nationalIdEnc)}, national_id_blind = ${buf(a.nationalIdBlind)},
        domain_verification = ${dvJson(a)}::jsonb, appeal_used = ${a.appealUsed}, appeal_statement = ${a.appealStatement},
        submitted_at = ${isoOrNull(a.submittedAtMs)}::timestamptz, decision = ${d?.decision ?? null},
        decision_reason_code = ${d?.reasonCode ?? null}, decision_message_ar = ${d?.messageAr ?? null},
        decision_message_en = ${d?.messageEn ?? null}, decided_at = ${isoOrNull(d?.decidedAtMs ?? null)}::timestamptz,
        reapply_after = ${isoOrNull(d?.reapplyAfterMs ?? null)}::timestamptz, appeal_allowed = ${d?.appealAllowed ?? false},
        decision_due_at = ${isoOrNull(a.decisionDueAtMs)}::timestamptz, rejected_at = ${isoOrNull(a.rejectedAtMs)}::timestamptz,
        store_id = ${a.storeId}::uuid, assignee_id = ${a.assigneeId}::uuid, claimed_at = ${isoOrNull(a.claimedAtMs)}::timestamptz,
        requested_items = ${itemsJson(a)}::jsonb, requested_at = ${isoOrNull(a.requestedAtMs)}::timestamptz
      where id = ${a.id}::uuid and version = ${mode.expected}`.execute(trx);
    return Number(r.numAffectedRows ?? 0);
  }

  async insert(row: ApplicationRow, history: HistoryDraft, events: readonly OutboxEventDraft[]): Promise<"created" | "duplicate_active"> {
    try {
      await this.tx({ kind: "applicant", applicantId: row.applicantId }, async (trx) => {
        await KyselyBrandApplicationRepository.writeApp(trx, row, "insert");
        await KyselyBrandApplicationRepository.history(trx, row.id, row.applicantId, history);
        if (events.length > 0) await raiseToSystem(trx);
        for (const e of events) await KyselyBrandApplicationRepository.event(trx, e);
      });
      return "created";
    } catch (e) {
      if (isUniqueViolation(e)) return "duplicate_active";
      throw e;
    }
  }

  private async docsFor(trx: SellersDb, ids: readonly string[]): Promise<Map<string, DocumentRow[]>> {
    const out = new Map<string, DocumentRow[]>();
    if (ids.length === 0) return out;
    const res = await sql<unknown>`select ${DOC_COLS} from brand_application_documents
      where application_id = any(${ids}::uuid[]) order by created_at, id`.execute(trx);
    for (const raw of res.rows) {
      const d = toDoc(DocDb.parse(raw));
      out.set(d.applicationId, [...(out.get(d.applicationId) ?? []), d]);
    }
    return out;
  }

  private async aggs(trx: SellersDb, rows: readonly unknown[]): Promise<AggregateRow[]> {
    const apps = rows.map((r) => toRow(AppDb.parse(r)));
    const docs = await this.docsFor(trx, apps.map((a) => a.id));
    return apps.map((app) => ({ app, documents: docs.get(app.id) ?? [] }));
  }

  async get(id: string, scope: RepoScope): Promise<AggregateRow | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
    return this.tx(scope, async (trx) => {
      const res = await sql<unknown>`select ${APP_COLS} from brand_applications where id = ${id}::uuid`.execute(trx);
      return (await this.aggs(trx, res.rows))[0] ?? null;
    });
  }

  private static pageOf(items: AggregateRow[], limit: number): Page<AggregateRow> {
    const more = items.length > limit;
    const shown = items.slice(0, limit);
    const last = shown[shown.length - 1];
    return { items: shown, next: more && last !== undefined ? { createdAtMs: last.app.createdAtMs, id: last.app.id } : null };
  }

  async listForApplicant(applicantId: string, after: Cursor | null, limit: number): Promise<Page<AggregateRow>> {
    return this.tx({ kind: "applicant", applicantId }, async (trx) => {
      const afterMs = after === null ? null : iso(after.createdAtMs);
      const res = await sql<unknown>`select ${APP_COLS} from brand_applications
        where applicant_id = ${applicantId}::uuid
          and (${afterMs}::timestamptz is null or (created_at, id) < (${afterMs}::timestamptz, ${after?.id ?? null}::uuid))
        order by created_at desc, id desc limit ${limit + 1}`.execute(trx);
      return KyselyBrandApplicationRepository.pageOf(await this.aggs(trx, res.rows), limit);
    });
  }

  async lastRejectedAtMs(applicantId: string, norm: string): Promise<number | null> {
    return this.tx({ kind: "applicant", applicantId }, async (trx) => {
      const res = await sql<{ m: string | null }>`select ${sql.raw(ms("max(rejected_at)"))} as m from brand_applications
        where applicant_id = ${applicantId}::uuid and brand_name_norm = ${norm} and status = 'REJECTED'`.execute(trx);
      const m = res.rows[0]?.m;
      return m === null || m === undefined ? null : Number(m);
    });
  }

  async countDocumentsSince(applicationId: string, sinceMs: number): Promise<number> {
    return this.tx({ kind: "system" }, async (trx) => {
      const res = await sql<{ n: string }>`select count(*)::text as n from brand_application_documents
        where application_id = ${applicationId}::uuid and created_at >= ${iso(sinceMs)}::timestamptz`.execute(trx);
      return Number(res.rows[0]?.n ?? 0);
    });
  }

  async commit(c: Commit): Promise<CommitResult> {
    try {
      return await this.tx(c.scope, async (trx) => {
        // Row-locking read under RLS: a foreign or missing row is invisible (not_found).
        const cur = await sql<{ version: number }>`select version from brand_applications where id = ${c.app.id}::uuid for update`.execute(trx);
        const current = cur.rows[0];
        if (current === undefined) return "not_found" as const;
        if (current.version !== c.expectedVersion || c.app.version !== c.expectedVersion + 1) return "conflict" as const;
        const n = await KyselyBrandApplicationRepository.writeApp(trx, c.app, { expected: c.expectedVersion });
        if (n === 0) return "conflict" as const;
        for (const d of c.documentsUpsert) await KyselyBrandApplicationRepository.upsertDoc(trx, d);
        for (const id of c.documentsDelete) {
          await sql`delete from brand_application_documents where id = ${id}::uuid and application_id = ${c.app.id}::uuid`.execute(trx);
        }
        if (c.history !== null) await KyselyBrandApplicationRepository.history(trx, c.app.id, c.app.applicantId, c.history);
        if (c.events.length > 0) await raiseToSystem(trx);
        for (const e of c.events) await KyselyBrandApplicationRepository.event(trx, e);
        return "ok" as const;
      });
    } catch (e) {
      if (isUniqueViolation(e)) return "duplicate_active";
      throw e;
    }
  }

  async listForReview(q: ReviewQueueQuery): Promise<Page<AggregateRow>> {
    return this.tx({ kind: "system" }, async (trx) => {
      const afterAt = q.after === null ? null : iso(q.after.createdAtMs);
      const res = await sql<unknown>`select ${APP_COLS} from brand_applications
        where status not in ('DRAFT','WITHDRAWN')
          and (${q.status ?? null}::text is null or status = ${q.status ?? null})
          and (${q.kind ?? null}::text is null or brand_kind = ${q.kind ?? null})
          and (${q.country ?? null}::text is null or country = ${q.country ?? null})
          and (${q.assigneeId ?? null}::text is null
               or (${q.assigneeId ?? null} = 'unassigned' and assignee_id is null)
               or (${q.assigneeId ?? null} <> 'unassigned' and assignee_id::text = ${q.assigneeId ?? null}))
          and (${q.slaBreachedAtMs === undefined ? null : iso(q.slaBreachedAtMs)}::timestamptz is null
               or (decision_due_at < ${q.slaBreachedAtMs === undefined ? null : iso(q.slaBreachedAtMs)}::timestamptz
                   and status in ('SUBMITTED','AUTO_CHECKS','IN_REVIEW')))
          and (${afterAt}::timestamptz is null or (created_at, id) < (${afterAt}::timestamptz, ${q.after?.id ?? null}::uuid))
        order by created_at desc, id desc limit ${q.limit + 1}`.execute(trx);
      return KyselyBrandApplicationRepository.pageOf(await this.aggs(trx, res.rows), q.limit);
    });
  }

  async history(applicationId: string): Promise<readonly HistoryRow[]> {
    return this.tx({ kind: "system" }, async (trx) => {
      const res = await sql<unknown>`select id::text as id, application_id::text as application_id, from_status, to_status, event, actor_type,
          actor_id::text as actor_id, reason_code, ${sql.raw(ms("occurred_at"))} as occurred_ms
        from brand_application_history where application_id = ${applicationId}::uuid order by occurred_at, id`.execute(trx);
      return res.rows.map((raw) => {
        const h = HistDb.parse(raw);
        return {
          id: h.id, applicationId: h.application_id, fromStatus: h.from_status, toStatus: h.to_status, event: h.event,
          actorType: h.actor_type, actorId: h.actor_id, reasonCode: h.reason_code, occurredAtMs: h.occurred_ms,
        };
      });
    });
  }

  async countOtherByNationalId(blind: Uint8Array, excludeId: string): Promise<number> {
    return this.tx({ kind: "system" }, async (trx) => {
      const res = await sql<{ n: string }>`select count(*)::text as n from brand_applications
        where national_id_blind = ${Buffer.from(blind)} and id <> ${excludeId}::uuid`.execute(trx);
      return Number(res.rows[0]?.n ?? 0);
    });
  }
}

