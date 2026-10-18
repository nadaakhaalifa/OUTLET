import { createHash } from "node:crypto";
import type {
  BrandReviewOverlay,
  BrandApplicationRecord,
  BrandApplicationsAdminPort,
  BrandStatus,
  DecisionCommand,
  DocumentMeta,
  ListFilter,
  ReadUrlResult,
  WriteResult,
} from "../modules/admin";
import type { SellerMembershipService } from "../modules/auth";
import type { BrandApplicationsAdminPort as SellersAdminPort } from "../modules/sellers";
import type {
  ApprovedPayload,
  AutoChecksPort,
  ProvisioningApplicationPort,
  ProvisioningFailureCode,
  SellerMembershipsPort,
} from "../modules/stores";

/**
 * Adapters from the PUBLIC ports of `sellers` and `auth` (seller side) to the ports the brand review
 * and provisioning slices consume. They hold no business rules.
 */

type SellersDetail = NonNullable<Awaited<ReturnType<SellersAdminPort["get"]>>>;
type SellersResult = Awaited<ReturnType<SellersAdminPort["claim"]>>;

export { InMemoryBrandReviewOverlay, type BrandReviewOverlay } from "../modules/admin";

/** Owner grant on approval through the seller auth public service. Idempotent per (user, store). */
export class AuthSellerMemberships implements SellerMembershipsPort {
  constructor(private readonly svc: Pick<SellerMembershipService, "grantStoreRole">) {}
  async grantOwner(i: { sellerUserId: string; storeId: string }): Promise<void> {
    const r = await this.svc.grantStoreRole({ sellerUserId: i.sellerUserId, storeId: i.storeId, role: "owner", grantedBy: null });
    if (r.kind !== "ok") throw new Error(`owner grant failed: ${r.kind}`);
  }
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

const STATUSES: readonly string[] = ["DRAFT", "SUBMITTED", "AUTO_CHECKS", "IN_REVIEW", "NEEDS_INFO", "APPROVED", "REJECTED", "SUSPENDED", "WITHDRAWN"];
const REASONS = [
  "ok", "ownership_not_proven", "documents_unreadable", "documents_inconsistent", "identity_mismatch", "domain_not_verified",
  "trademark_owner_mismatch", "not_a_brand", "prohibited_category", "counterfeit_confirmed", "sanctions_hit", "duplicate_claim",
  "incomplete_information", "other",
] as const;

const encodeCursor = (c: { createdAtMs: number; id: string }): string => Buffer.from(JSON.stringify([c.createdAtMs, c.id])).toString("base64url");
function decodeCursor(s: string | null): { createdAtMs: number; id: string } | null {
  if (s === null) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    return Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "string" ? { createdAtMs: v[0], id: v[1] } : null;
  } catch {
    return null;
  }
}

/** Review port over the sellers module's public admin port plus the overlay for cosign and failures. */
export class SellersReviewAdapter implements BrandApplicationsAdminPort, ProvisioningApplicationPort {
  constructor(
    private readonly sellers: SellersAdminPort,
    private readonly overlay: BrandReviewOverlay,
  ) {}

  private async toRecord(d: SellersDetail): Promise<BrandApplicationRecord> {
    const failure = d.status === "APPROVED" ? await this.overlay.getFailure(d.id) : null;
    const phone = d.contact["phone_e164"];
    const status: BrandStatus = failure !== null ? "PROVISIONING_FAILED" : (STATUSES.includes(d.status) ? d.status : "IN_REVIEW");
    return {
      id: d.id,
      version: d.version,
      status,
      brandName: d.brandName,
      brandKind: d.brandKind,
      country: d.country,
      applicantUserId: d.applicantId,
      applicantShopperUserId: null,
      // SHA-256 of the E.164 number; the ReviewerIdentityPort must use the same scheme.
      applicantPhoneHash: phone === undefined ? null : sha256(phone),
      brandDomain: d.websiteDomain,
      assigneeId: d.assigneeId,
      submittedAtMs: d.submittedAtMs ?? d.createdAtMs,
      decisionDueAtMs: d.decisionDueAtMs ?? (d.submittedAtMs ?? d.createdAtMs),
      appeal: d.appealUsed,
      highRiskCountry: false,
      riskScore: null,
      pendingCosign: await this.overlay.getCosign(d.id),
      claimConflictOpen: false,
      duplicateClaimApplicationIds: [],
      requestedItems: d.requestedItems.map((i) => ({ code: i.code, kind: i.kind, messageAr: i.messageAr, messageEn: i.messageEn })),
      decision:
        d.decision === null
          ? null
          : {
              decision: d.decision.decision === "approved" ? "approve" : d.decision.decision === "rejected" ? "reject" : "needs_info",
              reasonCode: REASONS.find((r) => r === d.decision?.reasonCode) ?? "other",
              messageAr: d.decision.messageAr,
              messageEn: d.decision.messageEn,
              decidedAtMs: d.decision.decidedAtMs,
            },
      internalNotes: [],
      history: d.history.map((h) => ({
        atMs: h.occurredAtMs,
        actorType: h.actorType === "ADMIN" ? "admin" : h.actorType === "APPLICANT" ? "applicant" : "system",
        event: h.event,
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
      })),
      storeId: d.storeId,
      provisioningFailure: failure,
      createdAtMs: d.createdAtMs,
      updatedAtMs: d.createdAtMs,
    };
  }

  async get(id: string): Promise<BrandApplicationRecord | null> {
    const d = await this.sellers.get(id);
    return d === null ? null : this.toRecord(d);
  }

  async list(f: ListFilter, cursor: string | null, limit: number) {
    const parkedOnly = f.status === "PROVISIONING_FAILED";
    const page = await this.sellers.list({
      ...(f.status !== undefined && !parkedOnly ? { status: f.status } : {}),
      ...(parkedOnly ? { status: "APPROVED" as const } : {}),
      ...(f.kind !== undefined ? { kind: f.kind } : {}),
      ...(f.country !== undefined ? { country: f.country } : {}),
      ...(f.assignee === "me" ? { assigneeId: f.adminId } : f.assignee === "unassigned" ? { assigneeId: "unassigned" as const } : {}),
      ...(f.slaBreachedAtMs !== undefined ? { slaBreachedAtMs: f.slaBreachedAtMs } : {}),
      after: decodeCursor(cursor),
      limit,
    });
    const items: BrandApplicationRecord[] = [];
    for (const s of page.items) {
      const d = await this.sellers.get(s.id);
      if (d === null) continue;
      const r = await this.toRecord(d);
      if (parkedOnly && r.status !== "PROVISIONING_FAILED") continue;
      if (f.appeal !== undefined && r.appeal !== f.appeal) continue;
      items.push(r);
    }
    return { items, nextCursor: page.next === null ? null : encodeCursor(page.next) };
  }

  private async result(id: string, r: SellersResult): Promise<WriteResult> {
    switch (r.kind) {
      case "ok":
        return { kind: "ok", record: await this.toRecord(r.application) };
      case "not_found":
        return { kind: "not_found" };
      case "version_conflict":
        return { kind: "version_conflict" };
      case "already_claimed":
        return { kind: "already_claimed" };
      case "invalid_transition":
        return { kind: "invalid_state", status: r.from };
      default: {
        const cur = await this.sellers.get(id);
        return { kind: "invalid_state", status: cur === null ? "IN_REVIEW" : cur.status };
      }
    }
  }

  async claim(id: string, adminId: string, expectedVersion: number, _atMs?: number): Promise<WriteResult> {
    return this.result(id, await this.sellers.claim({ id, adminId, expectedVersion }));
  }

  async release(id: string, expectedVersion: number, _atMs?: number): Promise<WriteResult> {
    const cur = await this.sellers.get(id);
    if (cur === null) return { kind: "not_found" };
    if (cur.assigneeId === null) return { kind: "ok", record: await this.toRecord(cur) };
    return this.result(id, await this.sellers.release({ id, adminId: cur.assigneeId, expectedVersion }));
  }

  async requestCosign(id: string, expectedVersion: number, firstApproverId: string, atMs: number): Promise<WriteResult> {
    const cur = await this.sellers.get(id);
    if (cur === null) return { kind: "not_found" };
    if (cur.version !== expectedVersion) return { kind: "version_conflict" };
    await this.overlay.setCosign(id, { firstApproverId, requestedAtMs: atMs });
    return { kind: "ok", record: await this.toRecord(cur) };
  }

  async applyDecision(id: string, expectedVersion: number, cmd: DecisionCommand): Promise<WriteResult> {
    const decided = cmd.decision === "approve" ? "approved" : cmd.decision === "reject" ? "rejected" : "needs_info";
    const r = await this.sellers.applyDecision({
      id,
      adminId: cmd.decidedBy,
      expectedVersion,
      input: {
        decision: decided,
        reasonCode: cmd.reasonCode,
        messageAr: cmd.publicMessageAr ?? "",
        messageEn: cmd.publicMessageEn ?? "",
        ...(cmd.decision === "needs_info"
          ? { requestedItems: cmd.requestedItems.map((i) => ({ code: i.code, kind: i.kind, messageAr: i.messageAr, messageEn: i.messageEn })) }
          : {}),
        sanctionsClear: cmd.sanctionsClear,
      },
    });
    if (r.kind === "ok") await this.overlay.clearCosign(id);
    return this.result(id, r);
  }

  // ---- ProvisioningApplicationPort -----------------------------------------------------------

  async payloadFor(applicationId: string): Promise<ApprovedPayload | null> {
    const d = await this.sellers.get(applicationId);
    if (d === null) return null;
    const reg = d.registration;
    return {
      application_id: d.id,
      applicant_seller_user_id: d.applicantId,
      brand_kind: d.brandKind,
      country: d.country,
      brand_name: d.brandName,
      brand_name_ar: null,
      locale: "ar",
      legal_name_ar: d.legalName,
      legal_name_en: null,
      registration_no: reg["commercial_register_no"] ?? reg["company_reg_no"] ?? null,
      tax_card_no: reg["tax_card_no"] ?? reg["vat_or_tax_id"] ?? null,
      governorate: null,
      slug_hint: null,
      eta_registration: null,
      restricted_listing: d.ownershipBasis === "third_party_reseller",
    };
  }

  async markProvisioned(applicationId: string, storeId: string): Promise<void> {
    const d = await this.sellers.get(applicationId);
    if (d === null) throw new Error("application vanished during provisioning");
    if (d.storeId === null) {
      const r = await this.sellers.markProvisioned({ id: applicationId, storeId, expectedVersion: d.version });
      if (r.kind !== "ok") throw new Error(`markProvisioned failed: ${r.kind}`);
    } else if (d.storeId !== storeId) {
      throw new Error("application already bound to a different store");
    }
    await this.overlay.clearFailure(applicationId);
  }

  async markProvisioningFailed(applicationId: string, code: ProvisioningFailureCode): Promise<void> {
    await this.overlay.setFailure(applicationId, code);
  }

  listFailed(limit: number): Promise<readonly string[]> {
    return this.overlay.listFailures(limit);
  }
}

/** Document access over the same sellers port (15 minute TTL is fixed there; the cap is re-checked by the review). */
export class SellersDocumentAccess {
  constructor(private readonly sellers: SellersAdminPort) {}

  async documents(applicationId: string): Promise<readonly DocumentMeta[]> {
    const d = await this.sellers.get(applicationId);
    if (d === null) return [];
    return d.documents.map((x) => ({
      id: x.id,
      requirementCode: x.requirementCode,
      contentType: x.contentType,
      sizeBytes: x.sizeBytes,
      scanStatus: x.scanStatus === "clean" || x.scanStatus === "infected" || x.scanStatus === "pending" ? x.scanStatus : "error",
      uploadStatus: x.uploadStatus === "uploaded" ? "uploaded" : "awaiting_upload",
    }));
  }

  async createReadUrl(
    applicationId: string,
    documentId: string,
    _ttlMs: number,
    _nowMs: number,
    ctx: { adminId: string; reasonCode: string },
  ): Promise<ReadUrlResult> {
    const r = await this.sellers.readDocumentUrl({ id: applicationId, documentId, adminId: ctx.adminId, reasonCode: ctx.reasonCode });
    if (r.kind === "ok") return { kind: "ok", url: r.url, expiresAtMs: r.expiresAtMs };
    return r.kind === "not_found" ? { kind: "not_found" } : { kind: "not_readable" };
  }
}

/** Drives SUBMITTED -> AUTO_CHECKS -> IN_REVIEW through the sellers port. Already-advanced is success. */
export class SellersAutoChecks implements AutoChecksPort {
  constructor(private readonly sellers: SellersAdminPort) {}
  async run(applicationId: string): Promise<void> {
    const d = await this.sellers.get(applicationId);
    if (d === null || d.status !== "SUBMITTED") return;
    const r = await this.sellers.runAutoChecks({ id: applicationId, expectedVersion: d.version });
    if (r.kind === "ok" || r.kind === "not_found" || r.kind === "invalid_transition") return;
    if (r.kind === "version_conflict") return; // another worker advanced it
    throw new Error(`runAutoChecks failed: ${r.kind}`);
  }
}
