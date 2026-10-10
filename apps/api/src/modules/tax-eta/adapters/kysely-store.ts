import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import {
  SUBMISSION_STATES,
  type DocumentKind,
  type ExemptionAuditEntry,
  type SigningDelegation,
  type TaxCategory,
  type VatExemption,
} from "../domain/bridge";
import type {
  AdminDocumentFilter,
  CreateDocumentOutcome,
  DocumentWithSubmission,
  Page,
  SaveCategoryOutcome,
  SignedDocumentStore,
  SignedPayload,
  SigningDelegationPort,
  StoredDocument,
  SubmissionRecord,
  TaxConfigRepository,
  TaxDocumentRepository,
} from "../domain/ports";
import { decodeCursor, encodeCursor } from "./cursor";
import { decodeDocument, encodeDocument } from "./codec";

/** Raw SQL only, rows validated with Zod (same approach as the returns and cart adapters). */
export type TaxEtaDb = Kysely<Record<string, never>>;

const Ms = z.string().regex(/^-?\d+$/).transform((s) => Number(s));

const Exemption = z.object({
  reasonAr: z.string(),
  reasonEn: z.string(),
  legalBasis: z.string(),
  effectiveFromMs: z.number().int(),
  effectiveToMs: z.number().int().nullable(),
});
const CategoryRow = z.object({
  code: z.string(),
  name_ar: z.string(),
  name_en: z.string(),
  rate_bps: z.number().int(),
  exemption: z.unknown(),
  version: z.number().int(),
});
const AuditRow = z.object({
  category_code: z.string(),
  actor_id: z.string(),
  action: z.enum(["exemption_set", "exemption_cleared"]),
  reason: z.string(),
  before_value: z.unknown(),
  after_value: z.unknown(),
  version_before: z.number().int(),
  version_after: z.number().int(),
  at_ms: Ms,
});
const DocRow = z.object({
  id: z.string(),
  store_id: z.string().nullable(),
  user_id: z.string().nullable(),
  document: z.unknown(),
  created_ms: Ms,
  s_state: z.enum(SUBMISSION_STATES),
  s_attempts: z.number().int(),
  s_max_attempts: z.number().int(),
  s_next_ms: Ms,
  s_last_ms: Ms.nullable(),
  s_last_error: z.string().nullable(),
  s_eta_uuid: z.string().nullable(),
  s_signed_ref: z.string().nullable(),
  s_reasons: z.unknown(),
  s_version: z.number().int(),
  s_created_ms: Ms,
  s_decided_ms: Ms.nullable(),
});

const exemptionOf = (raw: unknown): VatExemption | null => (raw === null || raw === undefined ? null : Exemption.parse(raw));
const exJson = (e: VatExemption | null): string | null => (e === null ? null : JSON.stringify(e));
const at = (ms: number) => sql`('epoch'::timestamptz + (${ms}::bigint * interval '1 millisecond'))`;

const DOC_SELECT = sql`
  select d.id::text as id, d.store_id::text as store_id, d.user_id::text as user_id, d.document,
         floor(extract(epoch from d.created_at) * 1000)::text as created_ms,
         s.state as s_state, s.attempts as s_attempts, s.max_attempts as s_max_attempts,
         floor(extract(epoch from s.next_attempt_at) * 1000)::text as s_next_ms,
         floor(extract(epoch from s.last_submitted_at) * 1000)::text as s_last_ms,
         s.last_error as s_last_error, s.eta_uuid as s_eta_uuid, s.signed_document_ref as s_signed_ref,
         s.rejection_reasons as s_reasons, s.version as s_version,
         floor(extract(epoch from s.created_at) * 1000)::text as s_created_ms,
         floor(extract(epoch from s.decided_at) * 1000)::text as s_decided_ms
    from tax_documents d join eta_submissions s on s.document_id = d.id`;

function toView(raw: unknown): DocumentWithSubmission {
  const r = DocRow.parse(raw);
  const reasons = Array.isArray(r.s_reasons) ? z.array(z.string()).parse(r.s_reasons) : null;
  return {
    stored: { id: r.id, document: decodeDocument(r.document), storeId: r.store_id, userId: r.user_id, createdAtMs: r.created_ms },
    submission: {
      documentId: r.id,
      internalId: decodeDocument(r.document).internalId,
      state: r.s_state,
      attempts: r.s_attempts,
      maxAttempts: r.s_max_attempts,
      nextAttemptAtMs: r.s_next_ms,
      lastSubmittedAtMs: r.s_last_ms,
      lastError: r.s_last_error,
      etaUuid: r.s_eta_uuid,
      signedDocumentRef: r.s_signed_ref,
      rejectionReasons: reasons,
      version: r.s_version,
      createdAtMs: r.s_created_ms,
      decidedAtMs: r.s_decided_ms,
    },
  };
}

abstract class Base {
  constructor(protected readonly db: TaxEtaDb) {}
  protected async tx<X>(run: (trx: TaxEtaDb) => Promise<X>): Promise<X> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return run(trx as unknown as TaxEtaDb);
    });
  }
}

export class KyselyTaxConfigRepository extends Base implements TaxConfigRepository {
  private static toCategory(raw: unknown): TaxCategory {
    const r = CategoryRow.parse(raw);
    return { code: r.code, nameAr: r.name_ar, nameEn: r.name_en, rateBps: BigInt(r.rate_bps), exemption: exemptionOf(r.exemption), version: r.version };
  }

  async listCategories(): Promise<readonly TaxCategory[]> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select code, name_ar, name_en, rate_bps, exemption, version from tax_categories order by code`.execute(trx);
      return r.rows.map(KyselyTaxConfigRepository.toCategory);
    });
  }

  async getCategory(code: string): Promise<TaxCategory | null> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select code, name_ar, name_en, rate_bps, exemption, version from tax_categories where code = ${code}`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : KyselyTaxConfigRepository.toCategory(row);
    });
  }

  async saveCategoryWithAudit(next: TaxCategory, audit: ExemptionAuditEntry): Promise<SaveCategoryOutcome> {
    return this.tx(async (trx) => {
      const upd = await sql`
        update tax_categories set exemption = ${exJson(next.exemption)}::jsonb, version = ${next.version}
         where code = ${next.code} and version = ${next.version - 1}`.execute(trx);
      if (Number(upd.numAffectedRows ?? 0n) === 0) {
        const exists = await sql`select 1 from tax_categories where code = ${next.code}`.execute(trx);
        return exists.rows.length === 0 ? "not_found" : "conflict";
      }
      await sql`
        insert into tax_exemption_audit (category_code, actor_id, action, reason, before_value, after_value, version_before, version_after, at)
        values (${audit.categoryCode}, ${audit.actorId}::uuid, ${audit.action}, ${audit.reason}, ${exJson(audit.before)}::jsonb,
                ${exJson(audit.after)}::jsonb, ${audit.versionBefore}, ${audit.versionAfter}, ${at(audit.atMs)})`.execute(trx);
      return "ok";
    });
  }

  async listAudit(categoryCode: string | null, limit: number): Promise<readonly ExemptionAuditEntry[]> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select category_code, actor_id::text as actor_id, action, reason, before_value, after_value, version_before, version_after,
               floor(extract(epoch from at) * 1000)::text as at_ms
          from tax_exemption_audit
         where (${categoryCode}::text is null or category_code = ${categoryCode})
         order by at desc, version_after desc limit ${limit}`.execute(trx);
      return r.rows.map((raw) => {
        const a = AuditRow.parse(raw);
        return {
          categoryCode: a.category_code,
          actorId: a.actor_id,
          atMs: a.at_ms,
          action: a.action,
          reason: a.reason,
          before: exemptionOf(a.before_value),
          after: exemptionOf(a.after_value),
          versionBefore: a.version_before,
          versionAfter: a.version_after,
        };
      });
    });
  }
}

function pageOf(items: DocumentWithSubmission[], limit: number): Page<DocumentWithSubmission> {
  const more = items.length > limit;
  const slice = items.slice(0, limit);
  const last = slice[slice.length - 1];
  return {
    items: slice,
    nextCursor: more && last !== undefined ? encodeCursor({ createdAtMs: last.stored.document.issuedAtMs, id: last.stored.id }) : null,
  };
}

export class KyselyTaxDocumentRepository extends Base implements TaxDocumentRepository {
  async createWithSubmission(stored: StoredDocument, s: SubmissionRecord): Promise<CreateDocumentOutcome> {
    const d = stored.document;
    return this.tx(async (trx) => {
      const ins = await sql<{ id: string }>`
        insert into tax_documents (id, internal_id, kind, source_ref, version, store_id, user_id, issuer_name_ar, recipient_name_ar,
                                   net_amount, vat_amount, gross_amount, document, issued_at, created_at)
        values (${stored.id}::uuid, ${d.internalId}, ${d.kind}, ${d.sourceRef}, ${d.version}, ${stored.storeId}::uuid, ${stored.userId}::uuid,
                ${d.issuer.legalNameAr}, ${d.recipient.legalNameAr}, ${d.totals.net.amount.toString()}::bigint,
                ${d.totals.vat.amount.toString()}::bigint, ${d.totals.gross.amount.toString()}::bigint,
                ${encodeDocument(d)}::jsonb, ${at(d.issuedAtMs)}, ${at(stored.createdAtMs)})
        on conflict do nothing returning id::text as id`.execute(trx);
      if (ins.rows.length === 0) {
        const r = await sql<unknown>`${DOC_SELECT} where d.internal_id = ${d.internalId}
                                        or (d.kind = ${d.kind} and d.source_ref = ${d.sourceRef} and d.version = ${d.version}) limit 1`.execute(trx);
        const row = r.rows[0];
        if (row === undefined) throw new Error("tax document insert conflicted but no row was found");
        return { kind: "duplicate", value: toView(row) };
      }
      await sql`
        insert into eta_submissions (document_id, internal_id, state, attempts, max_attempts, next_attempt_at, last_submitted_at,
                                     last_error, eta_uuid, signed_document_ref, rejection_reasons, decided_at, version, created_at)
        values (${stored.id}::uuid, ${s.internalId}, ${s.state}, ${s.attempts}, ${s.maxAttempts}, ${at(s.nextAttemptAtMs)},
                ${s.lastSubmittedAtMs === null ? null : at(s.lastSubmittedAtMs)}, ${s.lastError}, ${s.etaUuid}, ${s.signedDocumentRef},
                ${s.rejectionReasons === null ? null : JSON.stringify(s.rejectionReasons)}::jsonb,
                ${s.decidedAtMs === null ? null : at(s.decidedAtMs)}, ${s.version}, ${at(s.createdAtMs)})`.execute(trx);
      return { kind: "created", value: { stored, submission: s } };
    });
  }

  async findById(id: string): Promise<DocumentWithSubmission | null> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`${DOC_SELECT} where d.id::text = ${id}`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toView(row);
    });
  }

  async findByInternalId(internalId: string): Promise<DocumentWithSubmission | null> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`${DOC_SELECT} where d.internal_id = ${internalId}`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toView(row);
    });
  }

  private async keyset(
    where: ReturnType<typeof sql>,
    cursor: string | null,
    limit: number,
  ): Promise<Page<DocumentWithSubmission> | "invalid_cursor"> {
    const c = cursor === null ? null : decodeCursor(cursor);
    if (cursor !== null && c === null) return "invalid_cursor";
    return this.tx(async (trx) => {
      const after = c === null ? sql`true` : sql`(d.issued_at, d.id::text) < (${at(c.createdAtMs)}, ${c.id})`;
      const r = await sql<unknown>`${DOC_SELECT} where ${where} and ${after}
                                    order by d.issued_at desc, d.id::text desc limit ${limit + 1}`.execute(trx);
      return pageOf(r.rows.map(toView), limit);
    });
  }

  listForStores(storeIds: readonly string[], kinds: readonly DocumentKind[], cursor: string | null, limit: number) {
    return this.keyset(
      sql`d.store_id::text = any (${[...storeIds]}::text[]) and d.kind = any (${[...kinds]}::text[])`,
      cursor,
      limit,
    );
  }

  listAll(filter: AdminDocumentFilter, cursor: string | null, limit: number) {
    return this.keyset(
      sql`(${filter.state ?? null}::text is null or s.state = ${filter.state ?? null})
          and (${filter.kind ?? null}::text is null or d.kind = ${filter.kind ?? null})`,
      cursor,
      limit,
    );
  }

  async listDue(nowMs: number, limit: number): Promise<readonly DocumentWithSubmission[]> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`${DOC_SELECT}
        where s.state in ('QUEUED', 'RETRY') and s.next_attempt_at <= ${at(nowMs)}
        order by s.next_attempt_at, d.id limit ${limit}`.execute(trx);
      return r.rows.map(toView);
    });
  }

  async listAwaitingStatus(olderThanMs: number, limit: number): Promise<readonly DocumentWithSubmission[]> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`${DOC_SELECT}
        where s.state = 'SUBMITTED' and coalesce(s.last_submitted_at, 'epoch'::timestamptz) <= ${at(olderThanMs)}
        order by s.last_submitted_at nulls first, d.id limit ${limit}`.execute(trx);
      return r.rows.map(toView);
    });
  }

  async updateSubmission(next: SubmissionRecord, expectedVersion: number): Promise<boolean> {
    return this.tx(async (trx) => {
      const r = await sql`
        update eta_submissions set
            state = ${next.state}, attempts = ${next.attempts}, next_attempt_at = ${at(next.nextAttemptAtMs)},
            last_submitted_at = ${next.lastSubmittedAtMs === null ? null : at(next.lastSubmittedAtMs)},
            last_error = ${next.lastError}, eta_uuid = ${next.etaUuid}, signed_document_ref = ${next.signedDocumentRef},
            rejection_reasons = ${next.rejectionReasons === null ? null : JSON.stringify(next.rejectionReasons)}::jsonb,
            decided_at = ${next.decidedAtMs === null ? null : at(next.decidedAtMs)},
            version = ${expectedVersion + 1}
         where document_id = ${next.documentId}::uuid and version = ${expectedVersion}`.execute(trx);
      return Number(r.numAffectedRows ?? 0n) === 1;
    });
  }

  async listIssuedBetween(startMs: number, endMs: number): Promise<readonly DocumentWithSubmission[]> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`${DOC_SELECT}
        where d.issued_at >= ${at(startMs)} and d.issued_at < ${at(endMs)} order by d.issued_at, d.id`.execute(trx);
      return r.rows.map(toView);
    });
  }
}

export class KyselySignedDocumentStore extends Base implements SignedDocumentStore {
  async put(internalId: string, payload: SignedPayload) {
    const sha256 = createHash("sha256").update(payload.body, "utf8").digest("hex");
    const ref = `signed/${internalId}/${sha256.slice(0, 16)}`;
    await this.tx(async (trx) => {
      await sql`
        insert into eta_signed_documents (ref, internal_id, content_type, body, sha256)
        values (${ref}, ${internalId}, ${payload.contentType}, ${payload.body}, ${sha256}) on conflict (ref) do nothing`.execute(trx);
    });
    return { ref, sha256 };
  }
  async get(ref: string) {
    return this.tx(async (trx) => {
      const r = await sql<{ content_type: string; body: string; sha256: string }>`
        select content_type, body, sha256 from eta_signed_documents where ref = ${ref}`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : { contentType: row.content_type, body: row.body, sha256: row.sha256 };
    });
  }
}

export class KyselySigningDelegations extends Base implements SigningDelegationPort {
  async find(storeId: string): Promise<SigningDelegation | null> {
    return this.tx(async (trx) => {
      const r = await sql<{ active: boolean; signing_ref: string }>`
        select active, signing_ref from signing_delegations where store_id::text = ${storeId}`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : { sellerId: storeId, active: row.active, signingRef: row.signing_ref };
    });
  }
}
