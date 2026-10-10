import {
  APPROVAL_KINDS,
  APPROVER_ROLES,
  DEFAULT_APPROVAL_CONFIG,
  DEFAULT_ELEVATION_CONFIG,
  activateElevation,
  decideApproval,
  decideReview,
  isAdminReasonCode,
  kycMachine,
  newBreakGlass,
  newElevation,
  openSuspensionReview,
  requestApproval,
  revokeElevation,
  withdrawElevation,
  type AdminRoleName,
  type ApprovalConfig,
  type ApprovalKind,
  type ApprovalRecord,
  type ApprovalState,
  type ElevationConfig,
  type ElevationRecord,
  type KycContext,
  type KycState,
  type SuspensionReview,
} from "../domain/bridge";
import { hasAnyRole, type AdminAccess } from "../domain/access";
import type {
  AdminAuditPort,
  AdminStore,
  FlagAdminBackend,
  FlagView,
  PiiField,
  PiiSourcePort,
  SellerKycPort,
  SellerKycView,
} from "../domain/ports";

export interface Clock {
  nowMs(): number;
}
export interface IdPort {
  uuidV7(): string;
}

/** Context every command carries so audit rows can be correlated. */
export interface CommandMeta {
  readonly access: AdminAccess;
  readonly requestId: string | null;
}

const MAX_LIST = 200;

// ---------------------------------------------------------------- approvals

export type ApprovalVisibility = (a: AdminAccess, r: ApprovalRecord) => boolean;

/** Visible to the requester, to roles that may approve that kind, and to security. */
export const canSeeApproval: ApprovalVisibility = (a, r) =>
  r.requesterId === a.actorId ||
  hasAnyRole(a.effective, APPROVER_ROLES[r.kind]) ||
  hasAnyRole(a.effective, ["security"]);

export type RequestApprovalOutcome =
  | { readonly kind: "created"; readonly record: ApprovalRecord }
  | { readonly kind: "not_required" }
  | { readonly kind: "denied"; readonly reason: "requester_role_not_allowed" | "use_elevation_endpoint" }
  | { readonly kind: "invalid"; readonly reason: "reason_code_invalid" };

export interface RequestApprovalCommand {
  readonly kind: ApprovalKind;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly amountMinor: bigint | null;
  readonly reasonCode: string;
}

export type DecideOutcome =
  | { readonly kind: "decided"; readonly record: ApprovalRecord }
  | { readonly kind: "expired"; readonly record: ApprovalRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "denied"; readonly reason: "self_approval" | "approver_scope_missing" | "not_pending" }
  | { readonly kind: "conflict" };

export class DualApprovals {
  constructor(
    private readonly store: AdminStore,
    private readonly audit: AdminAuditPort,
    private readonly clock: Clock,
    private readonly ids: IdPort,
    private readonly config: ApprovalConfig = DEFAULT_APPROVAL_CONFIG,
  ) {}

  async request(meta: CommandMeta, cmd: RequestApprovalCommand): Promise<RequestApprovalOutcome> {
    if (cmd.kind === "role_elevation" || cmd.kind === "break_glass") {
      return { kind: "denied", reason: "use_elevation_endpoint" };
    }
    if (!isAdminReasonCode(cmd.reasonCode)) return { kind: "invalid", reason: "reason_code_invalid" };
    const now = this.clock.nowMs();
    const r = requestApproval(
      {
        id: this.ids.uuidV7(),
        kind: cmd.kind,
        subjectType: cmd.subjectType,
        subjectId: cmd.subjectId,
        amountMinor: cmd.amountMinor,
        reasonCode: cmd.reasonCode,
        requesterId: meta.access.actorId,
        requesterRoles: meta.access.effective,
        nowMs: now,
      },
      this.config,
    );
    if (r.kind !== "created") return r;
    await this.store.insertApproval(r.record);
    await this.audit.append({
      action: "approval.requested",
      actorId: meta.access.actorId,
      targetType: "approval",
      targetId: r.record.id,
      reasonCode: cmd.reasonCode,
      diff: { kind: cmd.kind, subject_type: cmd.subjectType, subject_id: cmd.subjectId, amount_minor: cmd.amountMinor?.toString() ?? null },
      requestId: meta.requestId,
      atMs: now,
    });
    return r;
  }

  /** null for "does not exist" and "not yours to see" alike (no object enumeration). */
  async get(access: AdminAccess, id: string): Promise<ApprovalRecord | null> {
    const r = await this.store.getApproval(id);
    return r !== null && canSeeApproval(access, r) ? r : null;
  }

  async list(
    access: AdminAccess,
    f: { readonly states?: readonly ApprovalState[]; readonly kinds?: readonly ApprovalKind[]; readonly mineOnly: boolean; readonly limit: number },
  ): Promise<readonly ApprovalRecord[]> {
    const rows = await this.store.listApprovals({
      ...(f.states !== undefined ? { states: f.states } : {}),
      ...(f.kinds !== undefined ? { kinds: f.kinds } : {}),
      ...(f.mineOnly ? { requesterId: access.actorId } : {}),
      visibleTo: {
        actorId: access.actorId,
        kinds: APPROVAL_KINDS.filter(
          (k) => hasAnyRole(access.effective, APPROVER_ROLES[k]) || hasAnyRole(access.effective, ["security"]),
        ),
      },
      limit: Math.min(f.limit, MAX_LIST),
    });
    return rows.filter((r) => canSeeApproval(access, r));
  }

  async decide(meta: CommandMeta, id: string, decision: "APPROVE" | "REJECT", note: string | null): Promise<DecideOutcome> {
    const existing = await this.get(meta.access, id);
    if (existing === null) return { kind: "not_found" };
    const now = this.clock.nowMs();
    const r = decideApproval(existing, {
      approverId: meta.access.actorId,
      approverRoles: meta.access.effective,
      decision,
      note,
      nowMs: now,
    });
    if (r.kind === "denied") return r;
    const saved = await this.store.saveApprovalDecision(r.record);
    if (!saved) return { kind: "conflict" };
    await this.audit.append({
      action: r.kind === "expired" ? "approval.expired" : decision === "APPROVE" ? "approval.approved" : "approval.rejected",
      actorId: meta.access.actorId,
      targetType: "approval",
      targetId: id,
      reasonCode: existing.reasonCode,
      diff: { kind: existing.kind, from: "REQUESTED", to: r.record.state, requester_id: existing.requesterId },
      requestId: meta.requestId,
      atMs: now,
    });
    return r.kind === "expired" ? { kind: "expired", record: r.record } : { kind: "decided", record: r.record };
  }
}

// --------------------------------------------------------------- elevation

export type RequestElevationOutcome =
  | { readonly kind: "created"; readonly elevation: ElevationRecord; readonly approval: ApprovalRecord }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "denied"; readonly reason: "requester_role_not_allowed" };

export type ElevationActionOutcome =
  | { readonly kind: "ok"; readonly elevation: ElevationRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "denied"; readonly reason: string }
  | { readonly kind: "conflict" };

export class RoleElevations {
  constructor(
    private readonly store: AdminStore,
    private readonly audit: AdminAuditPort,
    private readonly clock: Clock,
    private readonly ids: IdPort,
    private readonly approvalConfig: ApprovalConfig = DEFAULT_APPROVAL_CONFIG,
    private readonly config: ElevationConfig = DEFAULT_ELEVATION_CONFIG,
  ) {}

  async request(
    meta: CommandMeta,
    cmd: { readonly role: AdminRoleName; readonly reasonCode: string; readonly ttlMs: number | null },
  ): Promise<RequestElevationOutcome> {
    const now = this.clock.nowMs();
    const elevationId = this.ids.uuidV7();
    const approvalId = this.ids.uuidV7();
    const base = {
      id: elevationId,
      userId: meta.access.actorId,
      reasonCode: cmd.reasonCode,
      approvalId,
      ttlMs: cmd.ttlMs,
      heldRoles: meta.access.standing,
      nowMs: now,
    };
    const built =
      cmd.role === "super_admin"
        ? newBreakGlass(base, this.config)
        : newElevation({ ...base, role: cmd.role }, this.config);
    if (built.kind === "invalid") return { kind: "invalid", reason: built.reason };
    const kind: ApprovalKind = cmd.role === "super_admin" ? "break_glass" : "role_elevation";
    // Standing roles decide who may ask; the approval itself is always required (spec 23).
    const a = requestApproval(
      {
        id: approvalId,
        kind,
        subjectType: "elevation",
        subjectId: elevationId,
        amountMinor: null,
        reasonCode: cmd.reasonCode,
        requesterId: meta.access.actorId,
        requesterRoles: meta.access.standing,
        nowMs: now,
      },
      this.approvalConfig,
    );
    if (a.kind !== "created") return { kind: "denied", reason: "requester_role_not_allowed" };
    await this.store.createElevationWithApproval(a.record, built.record);
    await this.audit.append({
      action: kind === "break_glass" ? "break_glass.requested" : "elevation.requested",
      actorId: meta.access.actorId,
      targetType: "elevation",
      targetId: elevationId,
      reasonCode: cmd.reasonCode,
      diff: { role: cmd.role, approval_id: approvalId, ttl_ms: built.record.requestedTtlMs },
      requestId: meta.requestId,
      atMs: now,
    });
    return { kind: "created", elevation: built.record, approval: a.record };
  }

  /** Owner (and security/super_admin via elevationsAdmin) only. */
  async get(access: AdminAccess, id: string, admin: boolean): Promise<ElevationRecord | null> {
    const e = await this.store.getElevation(id);
    if (e === null) return null;
    return e.userId === access.actorId || admin ? e : null;
  }

  async activate(meta: CommandMeta, id: string): Promise<ElevationActionOutcome> {
    const e = await this.get(meta.access, id, false);
    if (e === null) return { kind: "not_found" };
    const approval = await this.store.getApproval(e.approvalId);
    const now = this.clock.nowMs();
    const r = activateElevation(e, approval, meta.access.actorId, now);
    if (r.kind === "denied") return { kind: "denied", reason: r.reason };
    if (!(await this.store.saveElevation(r.record, "PENDING_APPROVAL"))) return { kind: "conflict" };
    await this.audit.append({
      action: e.role === "super_admin" ? "break_glass.activated" : "elevation.activated",
      actorId: meta.access.actorId,
      targetType: "elevation",
      targetId: id,
      reasonCode: e.reasonCode,
      diff: { role: e.role, expires_at_ms: r.record.expiresAtMs, approval_id: e.approvalId },
      requestId: meta.requestId,
      atMs: now,
    });
    return { kind: "ok", elevation: r.record };
  }

  async revoke(meta: CommandMeta, id: string, admin: boolean): Promise<ElevationActionOutcome> {
    const e = await this.get(meta.access, id, admin);
    if (e === null) return { kind: "not_found" };
    const now = this.clock.nowMs();
    if (e.state === "PENDING_APPROVAL") {
      // Approved-but-not-activated (or still pending) elevations are withdrawn, never activatable after.
      const withdrawn = withdrawElevation(e, meta.access.actorId, now);
      if (!(await this.store.saveElevation(withdrawn, "PENDING_APPROVAL"))) return { kind: "conflict" };
      await this.audit.append({
        action: "elevation.withdrawn",
        actorId: meta.access.actorId,
        targetType: "elevation",
        targetId: id,
        reasonCode: e.reasonCode,
        diff: { role: e.role, user_id: e.userId, approval_id: e.approvalId, by_requester: e.userId === meta.access.actorId },
        requestId: meta.requestId,
        atMs: now,
      });
      return { kind: "ok", elevation: withdrawn };
    }
    if (e.state !== "ACTIVE") return { kind: "denied", reason: "not_active" };
    const next = revokeElevation(e, meta.access.actorId, now);
    if (!(await this.store.saveElevation(next, "ACTIVE"))) return { kind: "conflict" };
    await this.audit.append({
      action: "elevation.revoked",
      actorId: meta.access.actorId,
      targetType: "elevation",
      targetId: id,
      reasonCode: e.reasonCode,
      diff: { role: e.role, user_id: e.userId },
      requestId: meta.requestId,
      atMs: now,
    });
    return { kind: "ok", elevation: next };
  }

  mine(userId: string): Promise<readonly ElevationRecord[]> {
    return this.store.listElevations({ userId, limit: 50 });
  }

  active(): Promise<readonly ElevationRecord[]> {
    return this.store.listElevations({ activeAtMs: this.clock.nowMs(), limit: MAX_LIST });
  }
}

// ---------------------------------------------------------------- PII views

export type PiiViewOutcome =
  | { readonly kind: "ok"; readonly fields: Readonly<Partial<Record<PiiField, string>>> }
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid"; readonly reason: "reason_code_invalid" };

export class ViewPii {
  constructor(
    private readonly source: PiiSourcePort,
    private readonly audit: AdminAuditPort,
    private readonly clock: Clock,
  ) {}

  /**
   * The audit row (with its reason code) is written BEFORE the data is fetched, and a failed
   * append aborts the call: no logged reason, no data. Values are never written to the log.
   */
  async execute(
    meta: CommandMeta,
    cmd: { readonly subjectUserId: string; readonly fields: readonly PiiField[]; readonly reasonCode: string },
  ): Promise<PiiViewOutcome> {
    if (!isAdminReasonCode(cmd.reasonCode)) return { kind: "invalid", reason: "reason_code_invalid" };
    await this.audit.append({
      action: "pii_view.read",
      actorId: meta.access.actorId,
      targetType: "user",
      targetId: cmd.subjectUserId,
      reasonCode: cmd.reasonCode,
      diff: { fields: [...cmd.fields].sort().join(",") },
      requestId: meta.requestId,
      atMs: this.clock.nowMs(),
    });
    const data = await this.source.fetch(cmd.subjectUserId, cmd.fields);
    return data === null ? { kind: "not_found" } : { kind: "ok", fields: data };
  }
}

// -------------------------------------------------------------------- flags

export type FlagChangeOutcome =
  | { readonly kind: "ok"; readonly before: FlagView; readonly after: FlagView }
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid"; readonly reason: "reason_code_invalid" };

export class FeatureFlagAdmin {
  constructor(
    private readonly backend: FlagAdminBackend,
    private readonly audit: AdminAuditPort,
    private readonly clock: Clock,
  ) {}

  list(kind?: FlagView["kind"]): Promise<readonly FlagView[]> {
    return this.backend.list().then((all) => (kind === undefined ? all : all.filter((f) => f.kind === kind)));
  }

  get(key: string): Promise<FlagView | null> {
    return this.backend.get(key);
  }

  /** Audit first, then change: a flag cannot move without a durable record. */
  async set(meta: CommandMeta, key: string, enabled: boolean, reasonCode: string): Promise<FlagChangeOutcome> {
    if (!isAdminReasonCode(reasonCode)) return { kind: "invalid", reason: "reason_code_invalid" };
    const before = await this.backend.get(key);
    if (before === null) return { kind: "not_found" };
    await this.audit.append({
      action: before.kind === "kill_switch" ? "kill_switch.changed" : "feature_flag.changed",
      actorId: meta.access.actorId,
      targetType: "feature_flag",
      targetId: null,
      reasonCode,
      diff: { key, kind: before.kind, from: before.enabled, to: enabled },
      requestId: meta.requestId,
      atMs: this.clock.nowMs(),
    });
    const after = await this.backend.set(key, enabled);
    return after === null ? { kind: "not_found" } : { kind: "ok", before, after };
  }
}

// ---------------------------------------------------------------------- KYC

const NEUTRAL_KYC_CTX: KycContext = { documentsValid: false, sanctionsClear: false, signatoryAdult21: false };

export type KycOutcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid_transition"; readonly state: KycState }
  | { readonly kind: "denied"; readonly reason: "reviewer_is_suspender" | "not_open" }
  | { readonly kind: "invalid"; readonly reason: "reason_code_invalid" }
  | { readonly kind: "conflict" };

export interface KycTransitionView {
  readonly seller: SellerKycView;
  readonly review: SuspensionReview | null;
}

export class SellerKycAdmin {
  constructor(
    private readonly store: AdminStore,
    private readonly kyc: SellerKycPort,
    private readonly audit: AdminAuditPort,
    private readonly clock: Clock,
    private readonly ids: IdPort,
  ) {}

  queue(f: { readonly states?: readonly KycState[]; readonly limit: number }): Promise<readonly SellerKycView[]> {
    return this.kyc.list({ ...f, limit: Math.min(f.limit, MAX_LIST) });
  }

  async seller(sellerId: string): Promise<KycTransitionView | null> {
    const seller = await this.kyc.get(sellerId);
    if (seller === null) return null;
    return { seller, review: await this.store.findOpenReviewBySeller(sellerId) };
  }

  reviews(f: { readonly state?: SuspensionReview["state"]; readonly limit: number }): Promise<readonly SuspensionReview[]> {
    return this.store.listReviews({ ...f, limit: Math.min(f.limit, MAX_LIST) });
  }

  /** `meta` null means an automatic suspension (price-integrity ladder); the review is still owed. */
  async suspend(meta: CommandMeta | null, sellerId: string, reasonCode: string): Promise<KycOutcome<KycTransitionView>> {
    if (!isAdminReasonCode(reasonCode)) return { kind: "invalid", reason: "reason_code_invalid" };
    const seller = await this.kyc.get(sellerId);
    if (seller === null) return { kind: "not_found" };
    if (!kycMachine.can(seller.state, "SUSPEND", NEUTRAL_KYC_CTX)) return { kind: "invalid_transition", state: seller.state };
    const to = kycMachine.transition(seller.state, "SUSPEND", NEUTRAL_KYC_CTX);
    const now = this.clock.nowMs();
    if (!(await this.kyc.setState(sellerId, seller.state, to, now))) return { kind: "conflict" };
    const review = openSuspensionReview({
      id: this.ids.uuidV7(),
      sellerId,
      suspendedBy: meta?.access.actorId ?? null,
      reasonCode,
      nowMs: now,
    });
    await this.store.insertReview(review);
    await this.audit.append({
      action: "kyc.suspended",
      actorId: meta?.access.actorId ?? null,
      targetType: "seller",
      targetId: sellerId,
      reasonCode,
      diff: { from: seller.state, to, review_id: review.id, review_due_at_ms: review.dueAtMs, automatic: meta === null },
      requestId: meta?.requestId ?? null,
      atMs: now,
    });
    return { kind: "ok", value: { seller: { ...seller, state: to, updatedAtMs: now }, review } };
  }

  async reinstate(meta: CommandMeta, sellerId: string, reasonCode: string): Promise<KycOutcome<KycTransitionView>> {
    if (!isAdminReasonCode(reasonCode)) return { kind: "invalid", reason: "reason_code_invalid" };
    const seller = await this.kyc.get(sellerId);
    if (seller === null) return { kind: "not_found" };
    if (!kycMachine.can(seller.state, "REINSTATE", NEUTRAL_KYC_CTX)) return { kind: "invalid_transition", state: seller.state };
    const now = this.clock.nowMs();
    const open = await this.store.findOpenReviewBySeller(sellerId);
    let decided: SuspensionReview | null = null;
    if (open !== null) {
      const d = decideReview(open, meta.access.actorId, "REINSTATE", now);
      if (d.kind === "denied") return { kind: "denied", reason: d.reason };
      decided = d.review;
    }
    const to = kycMachine.transition(seller.state, "REINSTATE", NEUTRAL_KYC_CTX);
    if (!(await this.kyc.setState(sellerId, seller.state, to, now))) return { kind: "conflict" };
    if (decided !== null) await this.store.saveReview(decided);
    await this.audit.append({
      action: "kyc.reinstated",
      actorId: meta.access.actorId,
      targetType: "seller",
      targetId: sellerId,
      reasonCode,
      diff: { from: seller.state, to, review_id: decided?.id ?? null },
      requestId: meta.requestId,
      atMs: now,
    });
    return { kind: "ok", value: { seller: { ...seller, state: to, updatedAtMs: now }, review: decided } };
  }

  /** A human confirms the suspension stands. The seller stays SUSPENDED; the review closes. */
  async uphold(meta: CommandMeta, reviewId: string): Promise<KycOutcome<SuspensionReview>> {
    const review = await this.store.getReview(reviewId);
    if (review === null) return { kind: "not_found" };
    const now = this.clock.nowMs();
    const d = decideReview(review, meta.access.actorId, "UPHOLD", now);
    if (d.kind === "denied") return { kind: "denied", reason: d.reason };
    if (!(await this.store.saveReview(d.review))) return { kind: "conflict" };
    await this.audit.append({
      action: "kyc.suspension_upheld",
      actorId: meta.access.actorId,
      targetType: "seller",
      targetId: review.sellerId,
      reasonCode: review.reasonCode,
      diff: { review_id: reviewId },
      requestId: meta.requestId,
      atMs: now,
    });
    return { kind: "ok", value: d.review };
  }
}
