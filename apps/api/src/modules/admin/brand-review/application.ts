import type { CommandMeta } from "../application/admin";
import type { AdminAuditPort } from "../domain/ports";
import {
  MAX_READ_URL_TTL_MS,
  cosignCovers,
  reviewerIsApplicant,
  sanctionsClearIn,
  slaBreached,
  validateDecision,
  type AutoCheck,
  type BrandApplicationRecord,
  type BrandApplicationsAdminPort,
  type BrandVerificationPort,
  type DecisionCommand,
  type DocumentMeta,
  type DocumentReadReason,
  type FieldProblem,
  type ListFilter,
  type ProvisioningRetryOutcome,
  type ProvisioningRetryPort,
  type ReviewerIdentityPort,
  type WriteResult,
} from "./domain";

interface Clock {
  nowMs(): number;
}

export type ReviewFailure =
  | { readonly kind: "not_found" }
  | { readonly kind: "reviewer_is_applicant" }
  | { readonly kind: "not_assignee" }
  | { readonly kind: "already_claimed" }
  | { readonly kind: "invalid_transition"; readonly status: string }
  | { readonly kind: "version_conflict" }
  | { readonly kind: "claim_conflict_open" }
  | { readonly kind: "cosign_required" }
  | { readonly kind: "cosign_not_requested" }
  | { readonly kind: "cosign_same_admin" }
  | { readonly kind: "cosign_expired" }
  | { readonly kind: "elevation_required" }
  | { readonly kind: "document_not_readable" }
  | { readonly kind: "provisioning_unavailable" }
  | { readonly kind: "invalid"; readonly problems: readonly FieldProblem[] };

export type Outcome<T> = { readonly kind: "ok"; readonly value: T } | ReviewFailure;

export interface ApplicationDetail {
  readonly record: BrandApplicationRecord;
  readonly documents: readonly DocumentMeta[];
  readonly autoChecks: readonly AutoCheck[];
  readonly dualApprovalRequired: boolean;
  readonly slaBreached: boolean;
}

export interface DecideCommand {
  readonly decision: DecisionCommand["decision"];
  readonly reasonCode: DecisionCommand["reasonCode"];
  readonly publicMessageAr?: string | undefined;
  readonly publicMessageEn?: string | undefined;
  readonly requestedItems?: DecisionCommand["requestedItems"] | undefined;
  readonly internalNote?: string | undefined;
  readonly reapplyAfterDays?: number | undefined;
  readonly slug?: string | undefined;
  /** Optional If-Match version; a stale value is a 409 before anything is written. */
  readonly expectedVersion?: number | undefined;
}

const fail = <T>(r: WriteResult): Outcome<T> | null => {
  switch (r.kind) {
    case "ok":
      return null;
    case "not_found":
      return { kind: "not_found" };
    case "version_conflict":
      return { kind: "version_conflict" };
    case "already_claimed":
      return { kind: "already_claimed" };
    case "invalid_state":
      return { kind: "invalid_transition", status: r.status };
  }
};

/** Review use cases over BrandApplicationsAdminPort / BrandVerificationPort (spec section 2, 8). */
export class BrandReview {
  constructor(
    private readonly apps: BrandApplicationsAdminPort,
    private readonly verification: BrandVerificationPort,
    private readonly reviewers: ReviewerIdentityPort,
    private readonly audit: AdminAuditPort,
    private readonly clock: Clock,
    private readonly provisioning?: ProvisioningRetryPort,
  ) {}

  list(f: ListFilter, cursor: string | null, limit: number) {
    return this.apps.list(f, cursor, Math.min(limit, 50));
  }

  isSlaBreached(r: BrandApplicationRecord): boolean {
    return slaBreached(r, this.clock.nowMs());
  }

  async detail(id: string): Promise<ApplicationDetail | null> {
    const record = await this.apps.get(id);
    if (record === null) return null;
    const [documents, report] = await Promise.all([this.verification.documents(id), this.verification.autoCheckReport(id)]);
    return {
      record,
      documents,
      autoChecks: report?.checks ?? [],
      dualApprovalRequired: report?.dualApprovalRequired ?? record.highRiskCountry,
      slaBreached: this.isSlaBreached(record),
    };
  }

  private async guardReviewer(meta: CommandMeta, r: BrandApplicationRecord): Promise<ReviewFailure | null> {
    const who = await this.reviewers.identity(meta.access.actorId);
    return reviewerIsApplicant(r, who) ? { kind: "reviewer_is_applicant" } : null;
  }

  private async record(
    meta: CommandMeta,
    action: string,
    r: BrandApplicationRecord,
    reasonCode: string,
    diff: Readonly<Record<string, string | number | boolean | null>>,
  ): Promise<void> {
    await this.audit.append({
      action,
      actorId: meta.access.actorId,
      targetType: "brand_application",
      targetId: r.id,
      reasonCode,
      diff,
      requestId: meta.requestId,
      atMs: this.clock.nowMs(),
    });
  }

  async claim(meta: CommandMeta, id: string): Promise<Outcome<BrandApplicationRecord>> {
    const r = await this.apps.get(id);
    if (r === null) return { kind: "not_found" };
    const blocked = await this.guardReviewer(meta, r);
    if (blocked !== null) return blocked;
    if (r.status !== "IN_REVIEW") return { kind: "invalid_transition", status: r.status };
    if (r.assigneeId === meta.access.actorId) return { kind: "ok", value: r };
    if (r.assigneeId !== null) return { kind: "already_claimed" };
    const w = await this.apps.claim(id, meta.access.actorId, r.version, this.clock.nowMs());
    const f = fail<BrandApplicationRecord>(w);
    if (f !== null) return f;
    if (w.kind !== "ok") return { kind: "not_found" };
    await this.record(meta, "brand_application.claimed", w.record, "kyc_review", { status: w.record.status, version: w.record.version });
    return { kind: "ok", value: w.record };
  }

  async release(meta: CommandMeta, id: string, mayReleaseOthers: boolean): Promise<Outcome<BrandApplicationRecord>> {
    const r = await this.apps.get(id);
    if (r === null) return { kind: "not_found" };
    if (r.assigneeId === null) return { kind: "ok", value: r };
    if (r.assigneeId !== meta.access.actorId && !mayReleaseOthers) return { kind: "not_assignee" };
    const w = await this.apps.release(id, r.version, this.clock.nowMs());
    const f = fail<BrandApplicationRecord>(w);
    if (f !== null) return f;
    if (w.kind !== "ok") return { kind: "not_found" };
    await this.record(meta, "brand_application.released", w.record, "kyc_review", { released_from: r.assigneeId });
    return { kind: "ok", value: w.record };
  }

  async decide(meta: CommandMeta, id: string, cmd: DecideCommand): Promise<Outcome<BrandApplicationRecord>> {
    const problems = validateDecision(cmd);
    if (problems.length > 0) return { kind: "invalid", problems };
    const r = await this.apps.get(id);
    if (r === null) return { kind: "not_found" };
    const blocked = await this.guardReviewer(meta, r);
    if (blocked !== null) return blocked;
    if (cmd.expectedVersion !== undefined && cmd.expectedVersion !== r.version) return { kind: "version_conflict" };
    if (r.status !== "IN_REVIEW") return { kind: "invalid_transition", status: r.status };
    if (r.assigneeId !== meta.access.actorId) return { kind: "not_assignee" };

    const now = this.clock.nowMs();
    if (cmd.decision === "approve") {
      if (r.claimConflictOpen) return { kind: "claim_conflict_open" };
      const report = await this.verification.autoCheckReport(id);
      // Fail closed: no report means we cannot rule out the high-risk path.
      const dual = report === null ? true : report.dualApprovalRequired;
      if (dual) {
        if (r.pendingCosign !== null) return { kind: "cosign_required" };
        const w = await this.apps.requestCosign(id, r.version, meta.access.actorId, now);
        const f = fail<BrandApplicationRecord>(w);
        if (f !== null) return f;
        if (w.kind !== "ok") return { kind: "not_found" };
        await this.record(meta, "brand_application.cosign_requested", w.record, "kyc_review", {
          brand_reason_code: cmd.reasonCode,
          version: w.record.version,
        });
        return { kind: "ok", value: w.record };
      }
    }
    return this.apply(meta, r, cmd, null);
  }

  private async apply(
    meta: CommandMeta,
    r: BrandApplicationRecord,
    cmd: DecideCommand,
    cosignedBy: string | null,
  ): Promise<Outcome<BrandApplicationRecord>> {
    const now = this.clock.nowMs();
    const report = cmd.decision === "approve" ? await this.verification.autoCheckReport(r.id) : null;
    const w = await this.apps.applyDecision(r.id, r.version, {
      decision: cmd.decision,
      reasonCode: cmd.reasonCode,
      publicMessageAr: cmd.publicMessageAr ?? null,
      publicMessageEn: cmd.publicMessageEn ?? null,
      requestedItems: cmd.requestedItems ?? [],
      internalNote: cmd.internalNote ?? null,
      reapplyAfterDays: cmd.reapplyAfterDays ?? null,
      slug: cmd.slug ?? null,
      decidedBy: cosignedBy === null ? meta.access.actorId : (r.pendingCosign?.firstApproverId ?? meta.access.actorId),
      cosignedBy,
      sanctionsClear: report !== null && sanctionsClearIn(report.checks),
      atMs: now,
    });
    const f = fail<BrandApplicationRecord>(w);
    if (f !== null) return f;
    if (w.kind !== "ok") return { kind: "not_found" };
    await this.record(meta, `brand_application.${cmd.decision}`, w.record, "kyc_review", {
      from: r.status,
      to: w.record.status,
      brand_reason_code: cmd.reasonCode,
      requested_item_count: cmd.requestedItems?.length ?? 0,
      has_internal_note: cmd.internalNote !== undefined,
      cosigned: cosignedBy !== null,
      version: w.record.version,
    });
    return { kind: "ok", value: w.record };
  }

  /**
   * Second approver for dual-approval applications. Must be a different admin, holding ops or
   * trust_safety through a live JIT elevation (`elevatedReviewer`), and unlinked from the applicant.
   */
  async cosign(
    meta: CommandMeta,
    id: string,
    internalNote: string,
    elevatedReviewer: boolean,
    expectedVersion?: number,
  ): Promise<Outcome<BrandApplicationRecord>> {
    const r = await this.apps.get(id);
    if (r === null) return { kind: "not_found" };
    const blocked = await this.guardReviewer(meta, r);
    if (blocked !== null) return blocked;
    if (!elevatedReviewer) return { kind: "elevation_required" };
    if (expectedVersion !== undefined && expectedVersion !== r.version) return { kind: "version_conflict" };
    if (r.status !== "IN_REVIEW") return { kind: "invalid_transition", status: r.status };
    const covered = cosignCovers(r.pendingCosign, meta.access.actorId, this.clock.nowMs());
    if (covered === "none") return { kind: "cosign_not_requested" };
    if (covered === "same_admin") return { kind: "cosign_same_admin" };
    if (covered === "expired") return { kind: "cosign_expired" };
    if (r.claimConflictOpen) return { kind: "claim_conflict_open" };
    return this.apply(meta, r, { decision: "approve", reasonCode: "ok", internalNote }, meta.access.actorId);
  }

  /**
   * Audit row (with reason code) FIRST; if the append fails this throws and no URL is created.
   * The URL TTL is clamped to 15 minutes and a longer one from the port is refused (fail closed).
   */
  async documentReadUrl(
    meta: CommandMeta,
    id: string,
    documentId: string,
    reason: DocumentReadReason,
  ): Promise<Outcome<{ readonly url: string; readonly expiresAtMs: number }>> {
    const r = await this.apps.get(id);
    if (r === null) return { kind: "not_found" };
    const blocked = await this.guardReviewer(meta, r);
    if (blocked !== null) return blocked;
    if (r.assigneeId !== meta.access.actorId) return { kind: "not_assignee" };
    const docs = await this.verification.documents(id);
    if (!docs.some((d) => d.id === documentId)) return { kind: "not_found" };
    const now = this.clock.nowMs();
    await this.audit.append({
      action: "brand_document.read_url_requested",
      actorId: meta.access.actorId,
      targetType: "brand_document",
      targetId: documentId,
      reasonCode: reason,
      diff: { application_id: id },
      requestId: meta.requestId,
      atMs: now,
    });
    const u = await this.verification.createReadUrl(id, documentId, MAX_READ_URL_TTL_MS, now, { adminId: meta.access.actorId, reasonCode: reason });
    if (u.kind === "not_found") return { kind: "not_found" };
    if (u.kind === "not_readable") return { kind: "document_not_readable" };
    if (u.expiresAtMs > now + MAX_READ_URL_TTL_MS) throw new Error("document read url exceeds the 15 minute cap");
    return { kind: "ok", value: { url: u.url, expiresAtMs: u.expiresAtMs } };
  }

  /**
   * Admin retry of an application parked in PROVISIONING_FAILED. Only that state is retryable (409
   * otherwise). The retry is idempotent: the store id is derived from the application id, so it can
   * never create a second store. The audit row is written FIRST so a retry is never unrecorded; the
   * outcome is read back from the application (a still-failing retry returns the parked record).
   */
  async retryProvisioning(meta: CommandMeta, id: string): Promise<Outcome<{ readonly record: BrandApplicationRecord; readonly result: ProvisioningRetryOutcome }>> {
    const r = await this.apps.get(id);
    if (r === null) return { kind: "not_found" };
    const blocked = await this.guardReviewer(meta, r);
    if (blocked !== null) return blocked;
    if (r.status !== "PROVISIONING_FAILED") return { kind: "invalid_transition", status: r.status };
    if (this.provisioning === undefined) return { kind: "provisioning_unavailable" };
    await this.record(meta, "brand_application.provisioning_retry_requested", r, "provisioning_retry", {
      failure: r.provisioningFailure,
      version: r.version,
    });
    const result = await this.provisioning.retry(id);
    const after = (await this.apps.get(id)) ?? r;
    return { kind: "ok", value: { record: after, result } };
  }
}
