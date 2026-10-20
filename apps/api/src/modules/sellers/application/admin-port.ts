import { sellers } from "@outlet/domain";
import type {
  AdminApplicationDetail,
  AdminApplicationSummary,
  AdminDecisionInput,
  AdminResult,
  AggregateRow,
  ApplicationRow,
  BrandApplicationsAdminPort,
  DocumentRow,
  Page,
  PublicDecision,
  RequestedItem,
  ReviewQueueQuery,
} from "../domain/ports";
import type { ApplicationView } from "./codec";
import type { BrandApplicationService } from "./service";

const READ_URL_TTL_SECONDS = 15 * 60;
const REVIEWABLE: readonly sellers.ApplicationStatus[] = ["SUBMITTED", "AUTO_CHECKS", "IN_REVIEW"];

function summaryOf(a: ApplicationRow, nowMs: number): AdminApplicationSummary {
  return {
    id: a.id,
    status: a.status,
    version: a.version,
    brandKind: a.brandKind,
    country: a.country,
    brandName: a.brandName,
    submittedAtMs: a.submittedAtMs,
    decisionDueAtMs: a.decisionDueAtMs,
    slaBreached: a.decisionDueAtMs !== null && nowMs > a.decisionDueAtMs && REVIEWABLE.includes(a.status),
    assigneeId: a.assigneeId,
    appealUsed: a.appealUsed,
    createdAtMs: a.createdAtMs,
  };
}

const compact = (o: Record<string, string | null | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(o).filter((e): e is [string, string] => typeof e[1] === "string"));

/** Implementation of the public BrandApplicationsAdminPort over the same repository and rules as the applicant side. */
export class BrandApplicationsAdmin implements BrandApplicationsAdminPort {
  constructor(private readonly s: BrandApplicationService) {}

  private now(): number {
    return this.s.d.clock.nowMs();
  }

  private async detail(agg: AggregateRow): Promise<AdminApplicationDetail> {
    const v: ApplicationView = await this.s.view(agg);
    const r = v.row;
    const history = await this.s.d.repo.history(r.id);
    const dup = r.nationalIdBlind === null ? 0 : await this.s.d.repo.countOtherByNationalId(r.nationalIdBlind, r.id);
    return {
      ...summaryOf(r, this.now()),
      applicantId: r.applicantId,
      legalName: v.pii.legalName ?? null,
      registration: compact({
        commercial_register_no: r.commercialRegisterNo,
        tax_card_no: r.taxCardNo,
        company_reg_no: r.companyRegNo,
        company_reg_country: r.companyRegCountry,
        vat_or_tax_id: r.vatOrTaxId,
      }),
      trademark: compact({ register: r.trademarkRegister, number: r.trademarkNumber, owner_name: r.trademarkOwnerName }),
      ownershipBasis: r.ownershipBasis,
      websiteDomain: r.websiteDomain,
      domainVerification: r.domainVerification,
      contact: compact({ name: v.pii.contactName, phone_e164: v.pii.contactPhone, email: v.pii.contactEmail }),
      signatory: {
        fullName: v.pii.signatoryFullName ?? null,
        nationalIdLast4: v.nationalId === null ? null : v.nationalId.slice(-4),
        dateOfBirth: v.pii.signatoryDob ?? null,
      },
      duplicateNationalIdApplications: dup,
      documents: agg.documents.map((d) => ({
        id: d.id,
        requirementCode: d.requirementCode,
        contentType: d.contentType,
        sizeBytes: d.sizeBytes,
        uploadStatus: d.uploadStatus,
        scanStatus: d.scanStatus,
        reviewStatus: d.reviewStatus,
        reviewNotePublic: d.reviewNotePublic,
        reviewNoteInternal: d.reviewNoteInternal,
        originalFilename: v.filenames.get(d.id) ?? null,
      })),
      requestedItems: r.requestedItems,
      decision: r.decision,
      storeId: r.storeId,
      history: history.map(({ applicationId: _a, ...h }) => h),
    };
  }

  async list(q: ReviewQueueQuery): Promise<Page<AdminApplicationSummary>> {
    const now = this.now();
    const page = await this.s.d.repo.listForReview(q);
    return { items: page.items.map((a) => summaryOf(a.app, now)), next: page.next };
  }

  async get(id: string): Promise<AdminApplicationDetail | null> {
    const agg = await this.s.d.repo.get(id, { kind: "system" });
    return agg === null ? null : this.detail(agg);
  }

  private async mutate(
    id: string,
    expectedVersion: number,
    f: (agg: AggregateRow, nowMs: number) => Promise<AdminResult | { next: ApplicationRow; docs?: DocumentRow[]; history?: ReturnType<BrandApplicationService["draftHistory"]>; events?: ReturnType<BrandApplicationService["draftEvent"]>[] }>,
  ): Promise<AdminResult> {
    const agg = await this.s.d.repo.get(id, { kind: "system" });
    if (agg === null) return { kind: "not_found" };
    if (agg.app.version !== expectedVersion) return { kind: "version_conflict", currentVersion: agg.app.version };
    const nowMs = this.now();
    const out = await f(agg, nowMs);
    if ("kind" in out) return out;
    const res = await this.s.d.repo.commit({
      scope: { kind: "system" },
      expectedVersion,
      app: { ...out.next, version: expectedVersion + 1, updatedAtMs: nowMs },
      documentsUpsert: out.docs ?? [],
      documentsDelete: [],
      history: out.history ?? null,
      events: out.events ?? [],
    });
    if (res === "conflict") {
      const cur = await this.s.d.repo.get(id, { kind: "system" });
      return { kind: "version_conflict", currentVersion: cur?.app.version ?? expectedVersion };
    }
    if (res !== "ok") return { kind: "not_found" };
    const fresh = await this.s.d.repo.get(id, { kind: "system" });
    return fresh === null ? { kind: "not_found" } : { kind: "ok", application: await this.detail(fresh) };
  }

  claim(i: { id: string; adminId: string; expectedVersion: number }): Promise<AdminResult> {
    return this.mutate(i.id, i.expectedVersion, async (agg, nowMs) => {
      if (agg.app.applicantId === i.adminId) return { kind: "conflict_of_interest" };
      if (!REVIEWABLE.includes(agg.app.status)) return { kind: "invalid_transition", from: agg.app.status };
      if (agg.app.assigneeId !== null && agg.app.assigneeId !== i.adminId) return { kind: "already_claimed", assigneeId: agg.app.assigneeId };
      return { next: { ...agg.app, assigneeId: i.adminId, claimedAtMs: nowMs } };
    });
  }

  release(i: { id: string; adminId: string; expectedVersion: number }): Promise<AdminResult> {
    return this.mutate(i.id, i.expectedVersion, async (agg) => {
      if (agg.app.assigneeId !== i.adminId) return { kind: "not_claimed_by_actor" };
      return { next: { ...agg.app, assigneeId: null, claimedAtMs: null } };
    });
  }

  advanceChecks(i: { id: string; event: "START_CHECKS" | "FINISH_CHECKS"; expectedVersion: number }): Promise<AdminResult> {
    return this.mutate(i.id, i.expectedVersion, async (agg, nowMs) => {
      const v = await this.s.view(agg);
      let t: sellers.ApplicationTransition;
      try {
        t = sellers.applyApplicationEvent(agg.app.status, i.event, this.s.contextFor(v, nowMs));
      } catch (e) {
        return e instanceof Error && e.name === "GuardRejectedError" ? { kind: "guard_rejected", guard: e.message } : { kind: "invalid_transition", from: agg.app.status };
      }
      return { next: { ...agg.app, status: t.to }, history: this.s.draftHistory(agg.app, t.to, i.event, "SYSTEM", null, nowMs) };
    });
  }

  applyDecision(i: { id: string; adminId: string; expectedVersion: number; input: AdminDecisionInput }): Promise<AdminResult> {
    return this.mutate(i.id, i.expectedVersion, async (agg, nowMs) => {
      const row = agg.app;
      const input = i.input;
      if (row.applicantId === i.adminId) return { kind: "conflict_of_interest" };
      if (row.assigneeId !== i.adminId) return { kind: "not_claimed_by_actor" };
      if (input.decision === "needs_info" && (input.requestedItems === undefined || input.requestedItems.length === 0)) {
        return { kind: "invalid_input", code: "requested_items_required" };
      }
      const reviewed = new Map((input.documentReviews ?? []).map((r) => [r.documentId, r] as const));
      for (const id of reviewed.keys()) if (!agg.documents.some((d) => d.id === id)) return { kind: "invalid_input", code: "unknown_document" };
      const docs: DocumentRow[] = agg.documents.flatMap((d) => {
        const r = reviewed.get(d.id);
        return r === undefined
          ? []
          : [{ ...d, reviewStatus: r.reviewStatus, reviewNotePublic: r.notePublic ?? d.reviewNotePublic, reviewNoteInternal: r.noteInternal ?? d.reviewNoteInternal }];
      });
      const merged = agg.documents.map((d) => docs.find((x) => x.id === d.id) ?? d);
      const v = await this.s.view({ app: row, documents: merged });
      const event: sellers.ApplicationEvent = input.decision === "approved" ? "APPROVE" : input.decision === "rejected" ? "REJECT" : "REQUEST_INFO";
      let t: sellers.ApplicationTransition;
      try {
        t = sellers.applyApplicationEvent(row.status, event, this.s.contextFor(v, nowMs, { sanctionsClear: input.sanctionsClear === true }));
      } catch (e) {
        return e instanceof Error && e.name === "GuardRejectedError" ? { kind: "guard_rejected", guard: e.message } : { kind: "invalid_transition", from: row.status };
      }
      const decision: PublicDecision = {
        decision: input.decision,
        reasonCode: input.reasonCode,
        messageAr: input.messageAr,
        messageEn: input.messageEn,
        decidedAtMs: nowMs,
        reapplyAfterMs: input.decision === "rejected" ? sellers.reapplyAfterMs(nowMs) : null,
        appealAllowed: input.decision === "rejected" && !row.appealUsed,
      };
      const items: RequestedItem[] =
        input.decision === "needs_info"
          ? (input.requestedItems ?? []).map((r) => ({ code: r.code, kind: r.kind, messageAr: r.messageAr, messageEn: r.messageEn, satisfied: false }))
          : [...row.requestedItems];
      const next: ApplicationRow = {
        ...row,
        status: t.to,
        decision,
        requestedItems: items,
        requestedAtMs: input.decision === "needs_info" ? nowMs : row.requestedAtMs,
        rejectedAtMs: input.decision === "rejected" ? nowMs : row.rejectedAtMs,
      };
      return {
        next,
        docs,
        history: this.s.draftHistory(row, t.to, event, "ADMIN", i.adminId, nowMs, input.reasonCode),
        events: [
          this.s.draftEvent(next, `brand_application.${input.decision}`, nowMs, { from_status: t.from, to_status: t.to, reason_code: input.reasonCode }),
        ],
      };
    });
  }

  async readDocumentUrl(i: { id: string; documentId: string; adminId: string; reasonCode: string }) {
    const agg = await this.s.d.repo.get(i.id, { kind: "system" });
    const doc = agg?.documents.find((d) => d.id === i.documentId);
    if (agg === null || doc === undefined) return { kind: "not_found" as const };
    if (doc.uploadStatus !== "uploaded" || doc.scanStatus !== "clean") return { kind: "not_scanned_clean" as const };
    const signed = await this.s.d.store.signReadUrl(doc.objectKey, READ_URL_TTL_SECONDS);
    return { kind: "ok" as const, url: signed.url, expiresAtMs: signed.expiresAtMs };
  }

  async runAutoChecks(i: { id: string; expectedVersion: number }): Promise<AdminResult> {
    const agg = await this.s.d.repo.get(i.id, { kind: "system" });
    if (agg === null) return { kind: "not_found" };
    if (agg.app.version !== i.expectedVersion) return { kind: "version_conflict", currentVersion: agg.app.version };
    if (agg.app.status !== "SUBMITTED") return { kind: "invalid_transition", from: agg.app.status };
    const started = await this.advanceChecks({ id: i.id, event: "START_CHECKS", expectedVersion: i.expectedVersion });
    if (started.kind !== "ok") return started;
    const v = await this.s.view(agg);
    const r = agg.app;
    const dv = v.pii.legalName ?? r.brandName;
    const office = r.trademarkRegister === "EGYPT_TMO" ? "EGYPT-IP" : r.trademarkRegister === "OTHER_NATIONAL" ? "OTHER" : r.trademarkRegister;
    await this.s.d.verification.runAutoChecks({
      applicationId: r.id,
      applicantId: r.applicantId,
      kind: r.brandKind,
      country: r.country,
      brandName: r.brandName,
      legalName: dv,
      websiteDomain: r.websiteDomain,
      trademark:
        r.trademarkNumber !== null && (office === "WIPO" || office === "EUIPO" || office === "USPTO" || office === "EGYPT-IP" || office === "OTHER")
          ? { office, number: r.trademarkNumber }
          : null,
      submittedAtMs: r.submittedAtMs,
    });
    return this.advanceChecks({ id: i.id, event: "FINISH_CHECKS", expectedVersion: started.application.version });
  }

  markProvisioned(i: { id: string; storeId: string; expectedVersion: number }): Promise<AdminResult> {
    return this.mutate(i.id, i.expectedVersion, async (agg) => {
      if (agg.app.status !== "APPROVED") return { kind: "invalid_transition", from: agg.app.status };
      return { next: { ...agg.app, storeId: i.storeId } };
    });
  }
}
