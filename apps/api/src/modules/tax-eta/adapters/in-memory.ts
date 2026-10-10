/**
 * DEVELOPMENT AND TEST FIXTURES: per-process repositories, a scriptable fake ETA and a fake signed
 * document store. Nothing here talks to the real ETA portal (hard limit of this module).
 */
import { createHash } from "node:crypto";
import {
  DEFAULT_TAX_CATEGORIES,
  type DocumentKind,
  type EtaReportedItem,
  type ExemptionAuditEntry,
  type SigningDelegation,
  type TaxCategory,
  type TaxDocument,
} from "../domain/bridge";
import type {
  AdminDocumentFilter,
  CreateDocumentOutcome,
  DocumentWithSubmission,
  EtaPort,
  EtaStatusResult,
  EtaSubmitResult,
  Page,
  SaveCategoryOutcome,
  SignedDocumentStore,
  SignedPayload,
  SigningDelegationPort,
  StoredDocument,
  SubmissionRecord,
  TaxConfigRepository,
  TaxDocumentRepository,
  TaxEtaEvent,
  TaxEtaEventPublisher,
} from "../domain/ports";
import { decodeCursor, encodeCursor } from "./cursor";

export class InMemoryTaxConfigRepository implements TaxConfigRepository {
  private readonly categories = new Map<string, TaxCategory>(DEFAULT_TAX_CATEGORIES.map((c) => [c.code, c]));
  private readonly audit: ExemptionAuditEntry[] = [];

  async listCategories(): Promise<readonly TaxCategory[]> {
    return [...this.categories.values()].sort((a, b) => (a.code < b.code ? -1 : 1));
  }
  async getCategory(code: string): Promise<TaxCategory | null> {
    return this.categories.get(code) ?? null;
  }
  async saveCategoryWithAudit(next: TaxCategory, audit: ExemptionAuditEntry): Promise<SaveCategoryOutcome> {
    const cur = this.categories.get(next.code);
    if (cur === undefined) return "not_found";
    if (cur.version !== next.version - 1) return "conflict";
    this.categories.set(next.code, next);
    this.audit.push(audit);
    return "ok";
  }
  async listAudit(categoryCode: string | null, limit: number): Promise<readonly ExemptionAuditEntry[]> {
    return this.audit
      .filter((a) => categoryCode === null || a.categoryCode === categoryCode)
      .sort((a, b) => b.atMs - a.atMs || b.versionAfter - a.versionAfter)
      .slice(0, limit);
  }
}

function newestFirst(a: DocumentWithSubmission, b: DocumentWithSubmission): number {
  const ta = a.stored.document.issuedAtMs;
  const tb = b.stored.document.issuedAtMs;
  return ta !== tb ? tb - ta : a.stored.id < b.stored.id ? 1 : -1;
}

function pageOf(rows: readonly DocumentWithSubmission[], cursor: string | null, limit: number): Page<DocumentWithSubmission> | "invalid_cursor" {
  const c = cursor === null ? null : decodeCursor(cursor);
  if (cursor !== null && c === null) return "invalid_cursor";
  const sorted = [...rows].sort(newestFirst);
  const after =
    c === null
      ? sorted
      : sorted.filter((r) => r.stored.document.issuedAtMs < c.createdAtMs || (r.stored.document.issuedAtMs === c.createdAtMs && r.stored.id < c.id));
  const items = after.slice(0, limit);
  const last = items[items.length - 1];
  const more = after.length > limit;
  return {
    items,
    nextCursor: more && last !== undefined ? encodeCursor({ createdAtMs: last.stored.document.issuedAtMs, id: last.stored.id }) : null,
  };
}

export class InMemoryTaxDocumentRepository implements TaxDocumentRepository {
  private readonly docs = new Map<string, StoredDocument>();
  private readonly subs = new Map<string, SubmissionRecord>();

  private view(id: string): DocumentWithSubmission | null {
    const stored = this.docs.get(id);
    const submission = this.subs.get(id);
    return stored === undefined || submission === undefined ? null : { stored, submission };
  }
  private all(): DocumentWithSubmission[] {
    return [...this.docs.keys()].flatMap((id) => {
      const v = this.view(id);
      return v === null ? [] : [v];
    });
  }

  async createWithSubmission(stored: StoredDocument, submission: SubmissionRecord): Promise<CreateDocumentOutcome> {
    for (const e of this.docs.values()) {
      const d = e.document;
      if (d.internalId === stored.document.internalId || (d.kind === stored.document.kind && d.sourceRef === stored.document.sourceRef && d.version === stored.document.version)) {
        const v = this.view(e.id);
        if (v !== null) return { kind: "duplicate", value: v };
      }
    }
    this.docs.set(stored.id, stored);
    this.subs.set(stored.id, submission);
    return { kind: "created", value: { stored, submission } };
  }
  async findById(id: string): Promise<DocumentWithSubmission | null> {
    return this.view(id);
  }
  async findByInternalId(internalId: string): Promise<DocumentWithSubmission | null> {
    return this.all().find((v) => v.stored.document.internalId === internalId) ?? null;
  }
  async listForStores(storeIds: readonly string[], kinds: readonly DocumentKind[], cursor: string | null, limit: number) {
    return pageOf(
      this.all().filter((v) => v.stored.storeId !== null && storeIds.includes(v.stored.storeId) && kinds.includes(v.stored.document.kind)),
      cursor,
      limit,
    );
  }
  async listAll(filter: AdminDocumentFilter, cursor: string | null, limit: number) {
    return pageOf(
      this.all().filter(
        (v) => (filter.state === undefined || v.submission.state === filter.state) && (filter.kind === undefined || v.stored.document.kind === filter.kind),
      ),
      cursor,
      limit,
    );
  }
  async listDue(nowMs: number, limit: number): Promise<readonly DocumentWithSubmission[]> {
    return this.all()
      .filter((v) => (v.submission.state === "QUEUED" || v.submission.state === "RETRY") && v.submission.nextAttemptAtMs <= nowMs)
      .sort((a, b) => a.submission.nextAttemptAtMs - b.submission.nextAttemptAtMs || (a.stored.id < b.stored.id ? -1 : 1))
      .slice(0, limit);
  }
  async listAwaitingStatus(olderThanMs: number, limit: number): Promise<readonly DocumentWithSubmission[]> {
    return this.all()
      .filter((v) => v.submission.state === "SUBMITTED" && (v.submission.lastSubmittedAtMs ?? 0) <= olderThanMs)
      .sort((a, b) => (a.submission.lastSubmittedAtMs ?? 0) - (b.submission.lastSubmittedAtMs ?? 0))
      .slice(0, limit);
  }
  async updateSubmission(next: SubmissionRecord, expectedVersion: number): Promise<boolean> {
    const cur = this.subs.get(next.documentId);
    if (cur === undefined || cur.version !== expectedVersion) return false;
    this.subs.set(next.documentId, { ...next, version: expectedVersion + 1 });
    return true;
  }
  async listIssuedBetween(startMs: number, endMs: number): Promise<readonly DocumentWithSubmission[]> {
    return this.all().filter((v) => v.stored.document.issuedAtMs >= startMs && v.stored.document.issuedAtMs < endMs);
  }
}

export class InMemorySignedDocumentStore implements SignedDocumentStore {
  private readonly byRef = new Map<string, SignedPayload & { sha256: string }>();
  async put(internalId: string, payload: SignedPayload) {
    const sha256 = createHash("sha256").update(payload.body, "utf8").digest("hex");
    const ref = `signed/${internalId}/${sha256.slice(0, 16)}`;
    this.byRef.set(ref, { ...payload, sha256 });
    return { ref, sha256 };
  }
  async get(ref: string) {
    return this.byRef.get(ref) ?? null;
  }
}

export class InMemorySigningDelegations implements SigningDelegationPort {
  private readonly grants = new Map<string, SigningDelegation>();
  grant(storeId: string, active = true, signingRef = "delegation-ref"): void {
    this.grants.set(storeId, { sellerId: storeId, active, signingRef });
  }
  async find(storeId: string): Promise<SigningDelegation | null> {
    return this.grants.get(storeId) ?? null;
  }
}

export class InMemoryTaxEtaEventPublisher implements TaxEtaEventPublisher {
  readonly published: TaxEtaEvent[] = [];
  async publish(event: TaxEtaEvent): Promise<void> {
    this.published.push(event);
  }
}

type Script = EtaSubmitResult | "throw";

/**
 * Scriptable fake ETA. Idempotent on the internal id like the real portal: re-submitting a
 * document ETA has already decided returns the same decision. `script(internalId, ...results)`
 * queues one result per call; the default is to accept immediately.
 */
export class FakeEtaPort implements EtaPort {
  readonly submitCalls: string[] = [];
  private readonly scripts = new Map<string, Script[]>();
  private readonly decided = new Map<string, { status: "ACCEPTED" | "REJECTED" | "PENDING"; result: EtaSubmitResult }>();
  private statusOverride = new Map<string, EtaStatusResult>();
  dayReportUnavailable = false;
  /** Documents ETA reports that we never sent (for reconciliation tests). */
  readonly extraReported: EtaReportedItem[] = [];

  script(internalId: string, ...results: Script[]): void {
    this.scripts.set(internalId, [...(this.scripts.get(internalId) ?? []), ...results]);
  }
  setStatus(internalId: string, result: EtaStatusResult): void {
    this.statusOverride.set(internalId, result);
  }

  async submit(document: TaxDocument): Promise<EtaSubmitResult> {
    this.submitCalls.push(document.internalId);
    const prior = this.decided.get(document.internalId);
    if (prior !== undefined && prior.status !== "PENDING") return prior.result;
    const next = this.scripts.get(document.internalId)?.shift();
    if (next === "throw") throw new Error("network down");
    const result: EtaSubmitResult = next ?? {
      kind: "accepted",
      etaUuid: `eta-${document.internalId}`,
      signed: { contentType: "application/json", body: JSON.stringify({ internalId: document.internalId, signed: true }) },
    };
    if (result.kind === "accepted") this.decided.set(document.internalId, { status: "ACCEPTED", result });
    else if (result.kind === "rejected") this.decided.set(document.internalId, { status: "REJECTED", result });
    else if (result.kind === "pending") this.decided.set(document.internalId, { status: "PENDING", result });
    return result;
  }

  async status(internalId: string): Promise<EtaStatusResult> {
    const forced = this.statusOverride.get(internalId);
    if (forced !== undefined) return forced;
    const d = this.decided.get(internalId);
    if (d === undefined) return { kind: "not_found" };
    if (d.result.kind === "accepted") return { kind: "accepted", etaUuid: d.result.etaUuid, signed: d.result.signed };
    if (d.result.kind === "rejected") return { kind: "rejected", reasons: d.result.reasons };
    return { kind: "pending" };
  }

  async dayReport(): Promise<readonly EtaReportedItem[] | null> {
    if (this.dayReportUnavailable) return null;
    const own: EtaReportedItem[] = [...this.decided.entries()].map(([internalId, d]) => ({ internalId, status: d.status }));
    return [...own, ...this.extraReported];
  }
}
