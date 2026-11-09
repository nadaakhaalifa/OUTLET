import { assessAge } from "@outlet/auth-core";
import { withDbContext } from "@outlet/db";
import type { Principal } from "@outlet/policy";
import { authorize } from "@outlet/policy";
import { z } from "zod";
import { KYC_DOCUMENT_KINDS, kycGaps } from "../domain/documents.js";
import type { KycDocumentKind } from "../domain/documents.js";
import { OnboardingExistsError, SellerAccountsError, notFound, validation } from "../domain/errors.js";
import { isValidIban, normalizeIban } from "../domain/iban.js";
import { isKycEditable, nextKycState } from "../domain/kyc-state.js";
import type { KycEvent, KycState } from "../domain/kyc-state.js";
import { ACTIVE_CASE_INDEX, conflict, emit, isUniqueViolation, kycJob, makeEnv, pgCode, pgConstraint } from "./env.js";
import type { Env, SellerAccountsDeps } from "./env.js";
import type { Queryable } from "@outlet/outbox";
import type { KycCheckPort } from "./ports.js";

const Text = z.string().trim().min(1).max(200);
export const SellerDraftInput = z.strictObject({
  legal_type: z.enum(["company", "sole_trader"]),
  legal_name_ar: Text.optional(),
  legal_name_en: Text.optional(),
  commercial_register_no: Text.optional(),
  tax_card_no: Text.optional(),
  governorate_code: Text.optional(),
  governorate_name_ar: Text.optional(),
});
export type SellerDraftInput = z.input<typeof SellerDraftInput>;

export const LegalIdentityPatch = SellerDraftInput.omit({ legal_type: true });
export type LegalIdentityPatch = z.input<typeof LegalIdentityPatch>;

const DocumentInput = z.strictObject({ kind: z.enum(KYC_DOCUMENT_KINDS), mediaAssetId: z.uuid(), expiresOn: z.iso.date().optional() });
export type DocumentInput = z.input<typeof DocumentInput>;

const BankInput = z.strictObject({ iban: z.string().min(1).max(64), accountName: Text });
export type BankInput = z.input<typeof BankInput>;

const REASON = /^[a-z][a-z0-9_]{1,63}$/u;
export const DecisionInput = z.strictObject({
  decision: z.enum(["approve", "request_info", "reject"]),
  reasonCode: z.string().regex(REASON).optional(),
  note: z.string().trim().max(2000).optional(),
});
export type DecisionInput = z.input<typeof DecisionInput>;

export interface KycCaseView {
  readonly caseId: string;
  readonly sellerId: string;
  readonly state: KycState;
  readonly submittedAt: string | null;
  readonly decidedAt: string | null;
  readonly reasonCode: string | null;
  readonly version: number;
}

interface CaseRow {
  id: string;
  seller_id: string;
  state: KycState;
  submitted_at: Date | string | null;
  decided_at: Date | string | null;
  reason_code: string | null;
  version: number;
  applicant_user_id: string;
}
const CASE_COLS = "id, seller_id, state, submitted_at, decided_at, reason_code, version, applicant_user_id";

const iso = (v: Date | string | null): string | null => (v === null ? null : (v instanceof Date ? v : new Date(v)).toISOString());
const view = (r: CaseRow): KycCaseView => ({
  caseId: r.id, sellerId: r.seller_id, state: r.state, submittedAt: iso(r.submitted_at), decidedAt: iso(r.decided_at), reasonCode: r.reason_code, version: r.version,
});

interface SellerRow {
  legal_name_ar: string | null;
  commercial_register_no: string | null;
  tax_card_no: string | null;
  governorate_name_ar: string | null;
}

const SELLER_STATUS_FOR: Readonly<Record<KycState, string>> = {
  DRAFT: "draft", SUBMITTED: "kyc_pending", AUTO_CHECKS: "kyc_pending", NEEDS_INFO: "draft", APPROVED: "active", REJECTED: "closed", SUSPENDED: "suspended",
};

export class SellerOnboardingService {
  private readonly env: Env;
  constructor(
    deps: SellerAccountsDeps,
    private readonly checks: KycCheckPort,
  ) {
    this.env = makeEnv(deps);
  }

  private userCtx = <T>(userId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> =>
    withDbContext(this.env.app, { kind: "user", marketId: this.env.marketId, userId }, fn);

  /** Logs a state change (append-only), moves the case and the seller status. Caller holds the case row lock. */
  private async move(tx: Queryable, c: CaseRow, event: KycEvent, actor: { kind: "applicant" | "system" | "admin"; id?: string }, reason?: { code?: string; note?: string }): Promise<KycState> {
    const to = nextKycState(c.state, event);
    const at = this.env.now();
    const decided = to === "APPROVED" || to === "REJECTED" || to === "SUSPENDED";
    await tx.query(
      `UPDATE kyc_cases SET state = $2, version = version + 1, updated_at = $3,
              submitted_at = CASE WHEN $2 = 'SUBMITTED' THEN $3 ELSE submitted_at END,
              decided_at = CASE WHEN $4 THEN $3 ELSE decided_at END, decided_by = CASE WHEN $4 THEN $5::uuid ELSE decided_by END,
              reason_code = $6, reason_note = $7
        WHERE id = $1`,
      [c.id, to, at, decided, actor.id ?? null, reason?.code ?? null, reason?.note ?? null],
    );
    await tx.query(
      `INSERT INTO kyc_decisions (id, case_id, seller_id, market_id, from_state, to_state, actor_kind, actor_id, reason_code, reason_note, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [this.env.newId(), c.id, c.seller_id, this.env.marketId, c.state, to, actor.kind, actor.id ?? null, reason?.code ?? null, reason?.note ?? null, at],
    );
    try {
      await tx.query("UPDATE sellers SET status = $2, updated_at = $3 WHERE id = $1 AND market_id = $4", [c.seller_id, SELLER_STATUS_FOR[to], at, this.env.marketId]);
    } catch (e) {
      if (pgCode(e) === "23514") throw new SellerAccountsError("kyc_incomplete", "seller legal identity is incomplete", ["legal_identity"]);
      throw e;
    }
    return to;
  }

  private async lockCase(tx: Queryable, where: string, params: readonly unknown[]): Promise<CaseRow> {
    const r = await tx.query<CaseRow>(`SELECT ${CASE_COLS} FROM kyc_cases WHERE market_id = $1 AND kind = 'onboarding' AND ${where} FOR UPDATE`, [this.env.marketId, ...params]);
    const row = r.rows[0];
    if (row === undefined) throw notFound("kyc case");
    return row;
  }

  /** The applicant's live onboarding case (any state but REJECTED), if any. RLS limits the read to their own rows. */
  private async liveCase(tx: Queryable): Promise<{ sellerId: string; caseId: string } | undefined> {
    const r = await tx.query<{ id: string; seller_id: string }>(
      "SELECT id, seller_id FROM kyc_cases WHERE kind = 'onboarding' AND state <> 'REJECTED' ORDER BY created_at DESC, id DESC LIMIT 1",
    );
    const row = r.rows[0];
    return row === undefined ? undefined : { sellerId: row.seller_id, caseId: row.id };
  }

  /**
   * Any verified, active login may start a seller application; it becomes the applicant (and later first owner). Runs entirely under the
   * applicant's own outlet_app context (no worker job): the seller row goes through create_seller_draft(), the case through the
   * kyc_cases_user_isolation policy. One live case per applicant (409 onboarding_exists); a REJECTED case allows a fresh draft.
   */
  async createDraft(userId: string, raw: SellerDraftInput): Promise<{ sellerId: string; caseId: string }> {
    const input = SellerDraftInput.parse(raw);
    const sellerId = this.env.newId();
    const caseId = this.env.newId();
    const at = this.env.now();
    try {
      await this.userCtx(userId, async (tx) => {
        const u = await tx.query<{ status: string }>("SELECT status FROM users WHERE id = $1 AND market_id = $2", [userId, this.env.marketId]);
        if (u.rows[0]?.status !== "active") throw notFound("user");
        const existing = await this.liveCase(tx);
        if (existing !== undefined) throw new OnboardingExistsError(existing.sellerId, existing.caseId);
        await tx.query("SELECT create_seller_draft($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
          sellerId, input.legal_type, input.legal_name_ar ?? null, input.legal_name_en ?? null, input.commercial_register_no ?? null,
          input.tax_card_no ?? null, input.governorate_code ?? null, input.governorate_name_ar ?? null, at,
        ]);
        await tx.query("INSERT INTO kyc_cases (id, seller_id, market_id, applicant_user_id, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5)", [caseId, sellerId, this.env.marketId, userId, at]);
        await emit(this.env, tx, "seller.created", "seller", sellerId, { caseId });
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        if (pgConstraint(e) === ACTIVE_CASE_INDEX || (e instanceof Error && e.message.includes(ACTIVE_CASE_INDEX))) {
          // Lost a race with a parallel request of the same applicant: report the winner's ids.
          const existing = await this.userCtx(userId, (tx) => this.liveCase(tx));
          if (existing !== undefined) throw new OnboardingExistsError(existing.sellerId, existing.caseId);
        }
        throw conflict("commercial register number is already registered");
      }
      throw e;
    }
    return { sellerId, caseId };
  }

  async updateLegalIdentity(userId: string, sellerId: string, raw: LegalIdentityPatch): Promise<void> {
    const p = LegalIdentityPatch.parse(raw);
    const sets: string[] = [];
    const params: unknown[] = [sellerId, this.env.marketId, this.env.now()];
    for (const [col, v] of Object.entries(p)) {
      if (v === undefined) continue;
      params.push(v);
      sets.push(`${col} = $${String(params.length)}`);
    }
    if (sets.length === 0) return;
    try {
      await kycJob(this.env, userId, async (tx) => {
        const c = await this.lockCase(tx, "seller_id = $2 AND applicant_user_id = $3", [sellerId, userId]);
        if (!isKycEditable(c.state)) throw conflict(`case is ${c.state}`);
        await tx.query(`UPDATE sellers SET ${sets.join(", ")}, updated_at = $3 WHERE id = $1 AND market_id = $2`, params);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict("commercial register number is already registered");
      throw e;
    }
  }

  async addDocument(userId: string, sellerId: string, raw: DocumentInput): Promise<{ documentId: string }> {
    const input = DocumentInput.parse(raw);
    // The media row is platform-owned (store_id NULL), so outlet_app cannot see it; the existing media_assets__worker_platform
    // policy (job 'media.platform', read here) lets us verify the pointer.
    const m = await withDbContext(this.env.worker, { kind: "worker", marketId: this.env.marketId, job: "media.platform" }, (tx) =>
      tx.query<{ kind: string; status: string; created_by: string | null }>("SELECT kind, status, created_by FROM media_assets WHERE id = $1 AND market_id = $2", [input.mediaAssetId, this.env.marketId]),
    );
    const media = m.rows[0];
    if (media?.kind !== "document" || media.status !== "ready" || media.created_by !== userId) throw validation("media asset is not a ready document uploaded by you");
    const id = this.env.newId();
    return this.userCtx(userId, async (tx) => {
      const c = (await tx.query<CaseRow>(`SELECT ${CASE_COLS} FROM kyc_cases WHERE seller_id = $1 AND kind = 'onboarding'`, [sellerId])).rows[0];
      if (c === undefined) throw notFound("kyc case");
      if (!isKycEditable(c.state)) throw conflict(`case is ${c.state}`);
      try {
        await tx.query(
          `INSERT INTO kyc_documents (id, case_id, seller_id, market_id, kind, media_asset_id, expires_on, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
          [id, c.id, sellerId, this.env.marketId, input.kind, input.mediaAssetId, input.expiresOn ?? null, this.env.now()],
        );
      } catch (e) {
        if (isUniqueViolation(e)) throw conflict("document already attached");
        throw e;
      }
      return { documentId: id };
    });
  }

  /** Stores the payout IBAN encrypted (FieldCipher) with an HMAC blind index. Returns only the last four characters. */
  async setBankAccount(userId: string, sellerId: string, raw: BankInput): Promise<{ last4: string }> {
    const input = BankInput.parse(raw);
    if (!isValidIban(input.iban)) throw validation("invalid IBAN");
    const iban = normalizeIban(input.iban);
    const ct = await this.env.cipher.encrypt(iban, "seller_bank_accounts.iban_ct");
    const nameCt = await this.env.cipher.encrypt(input.accountName, "seller_bank_accounts.account_name_ct");
    const bidx = this.env.hasher.hmac("iban", `${this.env.marketId}:${iban}`);
    const last4 = iban.slice(-4);
    const at = this.env.now();
    await this.userCtx(userId, async (tx) => {
      const c = (await tx.query<CaseRow>(`SELECT ${CASE_COLS} FROM kyc_cases WHERE seller_id = $1 AND kind = 'onboarding'`, [sellerId])).rows[0];
      if (c === undefined) throw notFound("kyc case");
      if (!isKycEditable(c.state)) throw conflict(`case is ${c.state}`);
      const cur = await tx.query<{ id: string }>("SELECT id FROM seller_bank_accounts WHERE seller_id = $1 AND status <> 'rejected'", [sellerId]);
      const existing = cur.rows[0];
      if (existing === undefined) {
        await tx.query(
          `INSERT INTO seller_bank_accounts (id, seller_id, market_id, iban_ct, iban_bidx, iban_last4, account_name_ct, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
          [this.env.newId(), sellerId, this.env.marketId, ct, bidx, last4, nameCt, at],
        );
      } else {
        await tx.query("UPDATE seller_bank_accounts SET iban_ct = $2, iban_bidx = $3, iban_last4 = $4, account_name_ct = $5, updated_at = $6 WHERE id = $1", [existing.id, ct, bidx, last4, nameCt, at]);
      }
    });
    return { last4 };
  }

  async getCase(userId: string, sellerId: string): Promise<KycCaseView & { readonly gaps: readonly string[] }> {
    return this.userCtx(userId, async (tx) => {
      const c = (await tx.query<CaseRow>(`SELECT ${CASE_COLS} FROM kyc_cases WHERE seller_id = $1 AND kind = 'onboarding'`, [sellerId])).rows[0];
      if (c === undefined) throw notFound("kyc case");
      const kinds = await tx.query<{ kind: KycDocumentKind }>("SELECT kind FROM kyc_documents WHERE case_id = $1 AND status NOT IN ('rejected','superseded')", [c.id]);
      const bank = await tx.query<{ id: string }>("SELECT id FROM seller_bank_accounts WHERE seller_id = $1 AND status <> 'rejected'", [sellerId]);
      const s = (await tx.query<SellerRow>("SELECT legal_name_ar, commercial_register_no, tax_card_no, governorate_name_ar FROM sellers WHERE id = $1", [sellerId])).rows[0];
      const gaps = kycGaps({
        presentKinds: kinds.rows.map((k) => k.kind), thirdPartyBrands: false, hasBankAccount: bank.rows.length > 0,
        legalIdentity: { legalNameAr: s?.legal_name_ar ?? null, commercialRegisterNo: s?.commercial_register_no ?? null, taxCardNo: s?.tax_card_no ?? null, governorateNameAr: s?.governorate_name_ar ?? null },
      });
      return { ...view(c), gaps };
    });
  }

  /**
   * Submission gate: all required documents, a bank account, complete legal identity and a signatory aged 21+ (B6; the age is
   * recomputed from the applicant's own encrypted DOB and only the boolean is stored). Then runs the automatic checks.
   */
  async submit(userId: string, sellerId: string, opts: { readonly thirdPartyBrands?: boolean } = {}): Promise<KycCaseView> {
    // 1. The applicant is the actor: completeness and the signatory age are read under their own user context (users is user-isolated).
    const at = this.env.now();
    const caseId = await this.userCtx(userId, async (tx) => {
      const c = (await tx.query<CaseRow>(`SELECT ${CASE_COLS} FROM kyc_cases WHERE seller_id = $1 AND kind = 'onboarding'`, [sellerId])).rows[0];
      if (c === undefined) throw notFound("kyc case");
      nextKycState(c.state, "submit");
      const kinds = await tx.query<{ kind: KycDocumentKind }>("SELECT kind FROM kyc_documents WHERE case_id = $1 AND status NOT IN ('rejected','superseded')", [c.id]);
      const bank = await tx.query<{ id: string }>("SELECT id FROM seller_bank_accounts WHERE seller_id = $1 AND status <> 'rejected'", [sellerId]);
      const s = (await tx.query<SellerRow>("SELECT legal_name_ar, commercial_register_no, tax_card_no, governorate_name_ar FROM sellers WHERE id = $1", [sellerId])).rows[0];
      const gaps = kycGaps({
        presentKinds: kinds.rows.map((k) => k.kind), thirdPartyBrands: opts.thirdPartyBrands === true, hasBankAccount: bank.rows.length > 0,
        legalIdentity: { legalNameAr: s?.legal_name_ar ?? null, commercialRegisterNo: s?.commercial_register_no ?? null, taxCardNo: s?.tax_card_no ?? null, governorateNameAr: s?.governorate_name_ar ?? null },
      });
      if (gaps.length > 0) throw new SellerAccountsError("kyc_incomplete", "KYC submission is incomplete", gaps);
      const u = (await tx.query<{ dob_ct: Uint8Array | null }>("SELECT dob_ct FROM users WHERE id = $1 AND market_id = $2", [userId, this.env.marketId])).rows[0];
      if (u?.dob_ct == null) throw new SellerAccountsError("kyc_incomplete", "signatory date of birth is not on file", ["signatory_dob"]);
      const age = assessAge(await this.env.cipher.decrypt(u.dob_ct, "users.dob_ct"), at);
      if (age.ageBand !== "21_plus") throw new SellerAccountsError("signatory_under_21", "the signatory must be 21 or older");
      return c.id;
    });
    // 2. The 'seller.kyc' job records the (boolean) age result and moves the case, re-checking the state under the row lock.
    await kycJob(this.env, userId, async (tx) => {
      const c = await this.lockCase(tx, "id = $2 AND applicant_user_id = $3", [caseId, userId]);
      nextKycState(c.state, "submit");
      await tx.query(
        `INSERT INTO seller_signatories (id, seller_id, market_id, user_id, age_21_plus, age_checked_at) VALUES ($1,$2,$3,$4,true,$5)
         ON CONFLICT (seller_id, user_id) DO UPDATE SET age_21_plus = true, age_checked_at = $5`,
        [this.env.newId(), sellerId, this.env.marketId, userId, at],
      );
      await this.move(tx, c, "submit", { kind: "applicant", id: userId });
      await emit(this.env, tx, "seller.kyc_submitted", "seller", sellerId, { caseId: c.id });
    });
    return this.runAutoChecks(caseId);
  }

  /**
   * SUBMITTED -> AUTO_CHECKS through KycCheckPort. A failed IBAN-name match or document OCR sends the case to NEEDS_INFO
   * (reason auto_check_failed); a sanctions hit or "review" stays in AUTO_CHECKS for an administrator. Safe to retry
   * (a case already past SUBMITTED is returned unchanged), so a provider outage leaves the case SUBMITTED, not lost.
   */
  async runAutoChecks(caseId: string): Promise<KycCaseView> {
    const mat = await kycJob(this.env, undefined, async (tx) => {
      const c = (await tx.query<CaseRow>(`SELECT ${CASE_COLS} FROM kyc_cases WHERE id = $1 AND market_id = $2`, [caseId, this.env.marketId])).rows[0];
      if (c === undefined) throw notFound("kyc case");
      if (c.state !== "SUBMITTED") return { c, input: null };
      const s = (await tx.query<SellerRow>("SELECT legal_name_ar, commercial_register_no, tax_card_no, governorate_name_ar FROM sellers WHERE id = $1", [c.seller_id])).rows[0];
      const docs = await tx.query<{ id: string; kind: KycDocumentKind; media_asset_id: string }>("SELECT id, kind, media_asset_id FROM kyc_documents WHERE case_id = $1 AND status NOT IN ('rejected','superseded')", [c.id]);
      const b = (await tx.query<{ id: string; iban_ct: Uint8Array; account_name_ct: Uint8Array }>("SELECT id, iban_ct, account_name_ct FROM seller_bank_accounts WHERE seller_id = $1 AND status <> 'rejected'", [c.seller_id])).rows[0];
      if (s === undefined || b === undefined) throw new SellerAccountsError("kyc_incomplete", "case lost its seller or bank account", ["bank_account"]);
      return {
        c,
        bankId: b.id,
        input: {
          caseId: c.id, sellerId: c.seller_id, legalNameAr: s.legal_name_ar ?? "", commercialRegisterNo: s.commercial_register_no ?? "", taxCardNo: s.tax_card_no ?? "",
          iban: await this.env.cipher.decrypt(b.iban_ct, "seller_bank_accounts.iban_ct"), accountName: await this.env.cipher.decrypt(b.account_name_ct, "seller_bank_accounts.account_name_ct"),
          documents: docs.rows.map((d) => ({ id: d.id, kind: d.kind, mediaAssetId: d.media_asset_id })),
        },
      };
    });
    if (mat.input === null) return view(mat.c);
    const outcome = await this.checks.run(mat.input);
    return kycJob(this.env, undefined, async (tx) => {
      const c = await this.lockCase(tx, "id = $2", [caseId]);
      if (c.state !== "SUBMITTED") return view(c);
      const at = this.env.now();
      const results = outcome.checks.map((k) => ({ type: k.type, result: k.result, ...(k.scoreBp === undefined ? {} : { scoreBp: k.scoreBp }), ...(k.documentId === undefined ? {} : { documentId: k.documentId }), checkedAt: at.toISOString() }));
      await tx.query("UPDATE kyc_cases SET check_results = $2::jsonb, provider = $3, provider_ref = $4 WHERE id = $1", [c.id, JSON.stringify(results), outcome.provider, outcome.providerRef ?? null]);
      const failed = outcome.checks.filter((k) => k.result === "fail" && k.type !== "sanctions");
      for (const k of outcome.checks) {
        if (k.documentId === undefined) continue;
        await tx.query("UPDATE kyc_documents SET checks = checks || $2::jsonb, status = $3, updated_at = $4 WHERE id = $1 AND case_id = $5", [
          k.documentId, JSON.stringify([{ type: k.type, result: k.result, checkedAt: at.toISOString() }]), k.result === "fail" ? "rejected" : k.result === "pass" ? "verified" : "uploaded", at, c.id,
        ]);
      }
      const nameMatch = outcome.checks.find((k) => k.type === "iban_name_match");
      if (nameMatch !== undefined && nameMatch.result !== "review") {
        await tx.query(`UPDATE seller_bank_accounts SET status = $2, verified_at = $3, updated_at = $4 WHERE seller_id = $1 AND status <> 'rejected'`, [c.seller_id, nameMatch.result === "pass" ? "verified" : "rejected", nameMatch.result === "pass" ? at : null, at]);
      }
      const inChecks = { ...c, state: await this.move(tx, c, "start_checks", { kind: "system" }) };
      if (failed.length > 0) {
        await this.move(tx, inChecks, "request_info", { kind: "system" }, { code: "auto_check_failed", note: failed.map((f) => f.type).join(",") });
        await emit(this.env, tx, "seller.kyc_needs_info", "seller", c.seller_id, { caseId: c.id, reasonCode: "auto_check_failed" });
        return { ...view(c), state: "NEEDS_INFO", version: c.version + 2 };
      }
      return { ...view(c), state: "AUTO_CHECKS", version: c.version + 1 };
    });
  }

  private requireAdmin(admin: Principal, action: string): string {
    const d = authorize(admin, action, { type: "seller_kyc", marketId: this.env.marketId });
    if (d.effect === "deny") throw new SellerAccountsError(d.reason, d.reason === "not_found" ? "not found" : "forbidden");
    if (admin.kind !== "admin" || admin.userId === undefined) throw new SellerAccountsError("forbidden", "forbidden");
    return admin.userId;
  }

  private static reason(code: string | undefined, note: string | undefined, required: boolean): { code?: string; note?: string } {
    if (required && code === undefined) throw new SellerAccountsError("reason_required", "a reason code is required");
    return { ...(code === undefined ? {} : { code }), ...(note === undefined ? {} : { note }) };
  }

  /** Administrator decision on a case in AUTO_CHECKS (approve | request_info | reject). Needs seller_kyc.review. */
  async decide(admin: Principal, caseId: string, raw: DecisionInput): Promise<KycCaseView> {
    const input = DecisionInput.parse(raw);
    const adminId = this.requireAdmin(admin, "seller_kyc.review");
    const reason = SellerOnboardingService.reason(input.reasonCode, input.note, input.decision !== "approve");
    const event: KycEvent = input.decision === "approve" ? "approve" : input.decision === "reject" ? "reject" : "request_info";
    return kycJob(this.env, undefined, async (tx) => {
      const c = await this.lockCase(tx, "id = $2", [caseId]);
      const to = await this.move(tx, c, event, { kind: "admin", id: adminId }, reason);
      await emit(this.env, tx, `seller.kyc_${input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "needs_info"}`, "seller", c.seller_id, { caseId: c.id, ...(reason.code === undefined ? {} : { reasonCode: reason.code }) });
      return { ...view(c), state: to, version: c.version + 1 };
    });
  }

  /** Suspends an approved seller (needs store.suspend). Catalog and payouts react to seller.suspended. */
  async suspend(admin: Principal, sellerId: string, raw: { readonly reasonCode: string; readonly note?: string }): Promise<KycCaseView> {
    const adminId = this.requireAdmin(admin, "store.suspend");
    const reason = SellerOnboardingService.reason(z.string().regex(REASON).parse(raw.reasonCode), raw.note, true);
    return kycJob(this.env, undefined, async (tx) => {
      const c = await this.lockCase(tx, "seller_id = $2", [sellerId]);
      const to = await this.move(tx, c, "suspend", { kind: "admin", id: adminId }, reason);
      await emit(this.env, tx, "seller.suspended", "seller", sellerId, { caseId: c.id, reasonCode: reason.code ?? "" });
      return { ...view(c), state: to, version: c.version + 1 };
    });
  }
}
