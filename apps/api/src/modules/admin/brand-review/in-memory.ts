import {
  slaBreached,
  type BrandReviewOverlay,
  type OverlayFailureCode,
  type PendingCosign,
  type AutoCheckReport,
  type BrandApplicationRecord,
  type BrandApplicationsAdminPort,
  type BrandStatus,
  type BrandVerificationPort,
  type DecisionCommand,
  type DocumentMeta,
  type ListFilter,
  type ReadUrlResult,
  type ReviewerIdentity,
  type ReviewerIdentityPort,
  type WriteResult,
} from "./domain";

export interface OutboxEvent {
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

const encodeCursor = (r: BrandApplicationRecord): string => Buffer.from(`${r.decisionDueAtMs}:${r.id}`).toString("base64url");
const decodeCursor = (c: string): { dueMs: number; id: string } | null => {
  const [due, id] = Buffer.from(c, "base64url").toString("utf8").split(":");
  const dueMs = Number(due);
  return id !== undefined && Number.isFinite(dueMs) ? { dueMs, id } : null;
};

/** In-memory BrandApplicationsAdminPort. Stands in for the sellers module until it is wired. */
export class InMemoryBrandApplicationsAdmin implements BrandApplicationsAdminPort {
  private readonly rows = new Map<string, BrandApplicationRecord>();
  /** Stand-in for the transactional outbox the real module writes in the same tx as the state. */
  readonly outbox: OutboxEvent[] = [];

  seed(r: BrandApplicationRecord): void {
    this.rows.set(r.id, r);
  }

  async get(id: string): Promise<BrandApplicationRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async list(f: ListFilter, cursor: string | null, limit: number) {
    const after = cursor === null ? null : decodeCursor(cursor);
    const sorted = [...this.rows.values()]
      .filter((r) => {
        if (f.status !== undefined && r.status !== f.status) return false;
        if (f.status === undefined && ["DRAFT", "WITHDRAWN"].includes(r.status)) return false;
        if (f.kind !== undefined && r.brandKind !== f.kind) return false;
        if (f.country !== undefined && r.country !== f.country) return false;
        if (f.assignee === "me" && r.assigneeId !== f.adminId) return false;
        if (f.assignee === "unassigned" && r.assigneeId !== null) return false;
        if (f.appeal !== undefined && r.appeal !== f.appeal) return false;
        if (f.slaBreachedAtMs !== undefined && !slaBreached(r, f.slaBreachedAtMs)) return false;
        return true;
      })
      .sort((a, b) => a.decisionDueAtMs - b.decisionDueAtMs || (a.id < b.id ? -1 : 1));
    const rest = after === null ? sorted : sorted.filter((r) => r.decisionDueAtMs > after.dueMs || (r.decisionDueAtMs === after.dueMs && r.id > after.id));
    const items = rest.slice(0, limit);
    const last = items[items.length - 1];
    return { items, nextCursor: rest.length > limit && last !== undefined ? encodeCursor(last) : null };
  }

  private cas(id: string, expected: number, allowed: readonly BrandStatus[], next: (r: BrandApplicationRecord) => BrandApplicationRecord): WriteResult {
    const r = this.rows.get(id);
    if (r === undefined) return { kind: "not_found" };
    if (r.version !== expected) return { kind: "version_conflict" };
    if (!allowed.includes(r.status)) return { kind: "invalid_state", status: r.status };
    const n = next(r);
    this.rows.set(id, n);
    return { kind: "ok", record: n };
  }

  async claim(id: string, adminId: string, expectedVersion: number, atMs: number): Promise<WriteResult> {
    const cur = this.rows.get(id);
    if (cur !== undefined && cur.assigneeId !== null && cur.assigneeId !== adminId) return { kind: "already_claimed" };
    return this.cas(id, expectedVersion, ["IN_REVIEW"], (r) => ({
      ...r,
      assigneeId: adminId,
      version: r.version + 1,
      updatedAtMs: atMs,
      history: [...r.history, { atMs, actorType: "admin", event: "claimed", fromStatus: r.status, toStatus: r.status }],
    }));
  }

  async release(id: string, expectedVersion: number, atMs: number): Promise<WriteResult> {
    return this.cas(id, expectedVersion, ["IN_REVIEW"], (r) => ({
      ...r,
      assigneeId: null,
      version: r.version + 1,
      updatedAtMs: atMs,
      history: [...r.history, { atMs, actorType: "admin", event: "released", fromStatus: r.status, toStatus: r.status }],
    }));
  }

  async requestCosign(id: string, expectedVersion: number, firstApproverId: string, atMs: number): Promise<WriteResult> {
    return this.cas(id, expectedVersion, ["IN_REVIEW"], (r) => ({
      ...r,
      pendingCosign: { firstApproverId, requestedAtMs: atMs },
      version: r.version + 1,
      updatedAtMs: atMs,
      history: [...r.history, { atMs, actorType: "admin", event: "cosign_requested", fromStatus: r.status, toStatus: r.status }],
    }));
  }

  async applyDecision(id: string, expectedVersion: number, cmd: DecisionCommand): Promise<WriteResult> {
    const to: BrandStatus = cmd.decision === "approve" ? "APPROVED" : cmd.decision === "reject" ? "REJECTED" : "NEEDS_INFO";
    const res = this.cas(id, expectedVersion, ["IN_REVIEW"], (r) => ({
      ...r,
      status: to,
      assigneeId: null,
      pendingCosign: null,
      requestedItems: cmd.decision === "needs_info" ? cmd.requestedItems : r.requestedItems,
      decision: {
        decision: cmd.decision,
        reasonCode: cmd.reasonCode,
        messageAr: cmd.publicMessageAr ?? "",
        messageEn: cmd.publicMessageEn ?? "",
        decidedAtMs: cmd.atMs,
      },
      internalNotes:
        cmd.internalNote === null ? r.internalNotes : [...r.internalNotes, { adminId: cmd.cosignedBy ?? cmd.decidedBy, note: cmd.internalNote, atMs: cmd.atMs }],
      version: r.version + 1,
      updatedAtMs: cmd.atMs,
      history: [...r.history, { atMs: cmd.atMs, actorType: "admin", event: cmd.decision, fromStatus: r.status, toStatus: to }],
    }));
    if (res.kind === "ok") {
      this.outbox.push({
        type: `brand_application.${cmd.decision === "approve" ? "approved" : cmd.decision === "reject" ? "rejected" : "needs_info"}`,
        payload: {
          application_id: id,
          applicant_seller_user_id: res.record.applicantUserId,
          brand_kind: res.record.brandKind,
          country: res.record.country,
          brand_name: res.record.brandName,
          locale: "ar",
          slug_hint: cmd.slug,
        },
      });
    }
    return res;
  }

  /** Provisioning outcome write-back (what the sellers module does when the store exists or fails). */
  patch(id: string, p: Partial<BrandApplicationRecord>): void {
    const r = this.rows.get(id);
    if (r !== undefined) this.rows.set(id, { ...r, ...p });
  }
}

/** In-memory BrandVerificationPort with a scriptable report, documents and URL minting. */
export class InMemoryBrandVerification implements BrandVerificationPort {
  private readonly reports = new Map<string, AutoCheckReport>();
  private readonly docs = new Map<string, DocumentMeta[]>();
  /** TTL the fake grants. Tests raise it above 15 minutes to prove the cap fails closed. */
  grantTtlMs: number | null = null;
  readonly minted: { applicationId: string; documentId: string }[] = [];

  setReport(applicationId: string, r: AutoCheckReport): void {
    this.reports.set(applicationId, r);
  }
  addDocument(applicationId: string, d: DocumentMeta): void {
    this.docs.set(applicationId, [...(this.docs.get(applicationId) ?? []), d]);
  }
  async autoCheckReport(applicationId: string): Promise<AutoCheckReport | null> {
    return this.reports.get(applicationId) ?? null;
  }
  async documents(applicationId: string): Promise<readonly DocumentMeta[]> {
    return this.docs.get(applicationId) ?? [];
  }
  async createReadUrl(applicationId: string, documentId: string, ttlMs: number, nowMs: number, _ctx: { adminId: string; reasonCode: string }): Promise<ReadUrlResult> {
    const d = (this.docs.get(applicationId) ?? []).find((x) => x.id === documentId);
    if (d === undefined) return { kind: "not_found" };
    if (d.scanStatus !== "clean" || d.uploadStatus !== "uploaded") return { kind: "not_readable" };
    this.minted.push({ applicationId, documentId });
    return { kind: "ok", url: `https://files.example.test/signed/${documentId}?sig=fake`, expiresAtMs: nowMs + (this.grantTtlMs ?? ttlMs) };
  }
}

export class InMemoryReviewerIdentity implements ReviewerIdentityPort {
  private readonly byId = new Map<string, ReviewerIdentity>();
  set(i: ReviewerIdentity): void {
    this.byId.set(i.userId, i);
  }
  async identity(adminUserId: string): Promise<ReviewerIdentity> {
    return this.byId.get(adminUserId) ?? { userId: adminUserId, phoneHash: null, emailDomain: null };
  }
}

/** In-memory overlay: dev boot and the contract test's reference implementation. */
export class InMemoryBrandReviewOverlay implements BrandReviewOverlay {
  private readonly cosigns = new Map<string, PendingCosign>();
  private readonly failures = new Map<string, { code: OverlayFailureCode; seq: number }>();
  private readonly conflicts = new Map<string, string>();
  readonly retries = new Map<string, number>();
  private seq = 0;
  async getCosign(id: string) {
    return this.cosigns.get(id) ?? null;
  }
  async setCosign(id: string, c: PendingCosign) {
    this.cosigns.set(id, c);
  }
  async clearCosign(id: string) {
    this.cosigns.delete(id);
  }
  async getFailure(id: string) {
    return this.failures.get(id)?.code ?? null;
  }
  async setFailure(id: string, code: OverlayFailureCode) {
    const cur = this.failures.get(id);
    this.failures.set(id, { code, seq: cur?.seq ?? ++this.seq });
  }
  async clearFailure(id: string) {
    this.failures.delete(id);
    this.conflicts.delete(id);
    this.retries.delete(id);
  }
  async listFailures(limit: number) {
    return [...this.failures.entries()].sort((a, b) => a[1].seq - b[1].seq).slice(0, limit).map(([id]) => id);
  }
  async recordConflict(id: string, storeId: string) {
    this.conflicts.set(id, storeId);
  }
  async conflictingStoreId(id: string) {
    return this.conflicts.get(id) ?? null;
  }
  async recordRetry(id: string) {
    this.retries.set(id, (this.retries.get(id) ?? 0) + 1);
  }
}
