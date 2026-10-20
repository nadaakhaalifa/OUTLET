import {
  DEFAULT_BACKOFF,
  DEFAULT_MAX_ATTEMPTS,
  DomainError,
  applyExemptionChange,
  backoffDelayMs,
  buildSellerGoodsReceipt,
  buildTaxDocument,
  cairoDayWindow,
  type EtaReportedItem,
  computeOrderTax,
  reconcileDay,
  submissionMachine,
  type BackoffConfig,
  type BuildDocumentInput,
  type DocumentKind,
  type ExemptionChange,
  type OrderTax,
  type ReconciliationReport,
  type SubmissionEvent,
  type SubmissionState,
  type TaxCategory,
  type TaxDocument,
  type TaxLineInput,
} from "../domain/bridge";
import type {
  AdminDocumentFilter,
  DocumentWithSubmission,
  EtaPort,
  Page,
  SignedDocumentStore,
  SigningDelegationPort,
  SubmissionRecord,
  TaxConfigRepository,
  TaxDocumentRepository,
  TaxEtaEventPublisher,
} from "../domain/ports";

export interface Clock {
  nowMs(): number;
}
export interface Ids {
  uuidV7(): string;
  hex(bytes: number): string;
}

export interface TaxEtaDeps {
  readonly config: TaxConfigRepository;
  readonly documents: TaxDocumentRepository;
  readonly eta: EtaPort;
  readonly signed: SignedDocumentStore;
  readonly delegations: SigningDelegationPort;
  readonly events: TaxEtaEventPublisher;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly backoff?: BackoffConfig;
  readonly maxAttempts?: number;
}

const categoryMap = (list: readonly TaxCategory[]): ReadonlyMap<string, TaxCategory> => new Map(list.map((c) => [c.code, c]));

function random01(ids: Ids): number {
  return parseInt(ids.hex(4), 16) / 2 ** 32;
}

/** Quote line level tax for an order or basket (pure over the stored categories, no side effects). */
export class QuoteOrderTax {
  constructor(private readonly d: TaxEtaDeps) {}
  async execute(input: {
    readonly lines: readonly TaxLineInput[];
    readonly orderDiscountPiastres: bigint;
  }): Promise<{ readonly kind: "ok"; readonly tax: OrderTax } | { readonly kind: "invalid"; readonly message: string }> {
    try {
      const categories = categoryMap(await this.d.config.listCategories());
      const tax = computeOrderTax({
        lines: input.lines,
        orderDiscount: { amount: input.orderDiscountPiastres, currency: "EGP" },
        categories,
        atMs: this.d.clock.nowMs(),
      });
      return { kind: "ok", tax };
    } catch (e) {
      if (e instanceof DomainError) return { kind: "invalid", message: e.message };
      throw e;
    }
  }
}

export type IssueResult =
  | { readonly kind: "ok"; readonly value: DocumentWithSubmission; readonly duplicate: boolean }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "delegation_required" };

export interface IssueInput extends Omit<BuildDocumentInput, "categories" | "issuedAtMs" | "kind"> {
  readonly kind: DocumentKind;
  /** The seller store (e-invoice recipient / goods issuer) or the shopper (receipt recipient). */
  readonly storeId: string | null;
  readonly userId: string | null;
}

/** Builds a document, stores it and enqueues its ETA submission, once per (kind, sourceRef, version). */
export class IssueDocument {
  constructor(private readonly d: TaxEtaDeps) {}

  async execute(input: IssueInput): Promise<IssueResult> {
    const now = this.d.clock.nowMs();
    const categories = categoryMap(await this.d.config.listCategories());
    let document: TaxDocument;
    try {
      const base = { ...input, categories, issuedAtMs: now };
      if (input.kind === "seller_goods_ereceipt") {
        if (input.storeId === null) return { kind: "invalid", message: "storeId is required for a goods receipt" };
        const delegation = await this.d.delegations.find(input.storeId);
        const { kind: _kind, storeId: _s, userId: _u, ...rest } = base;
        void _kind;
        void _s;
        void _u;
        document = buildSellerGoodsReceipt(rest, delegation);
      } else {
        const { storeId: _s, userId: _u, ...rest } = base;
        void _s;
        void _u;
        document = buildTaxDocument(rest);
      }
    } catch (e) {
      if (e instanceof DomainError) {
        if (e.name === "DelegationRequiredError") return { kind: "delegation_required" };
        return { kind: "invalid", message: e.message };
      }
      throw e;
    }
    const wantsStore = document.kind !== "shopper_ereceipt";
    if (wantsStore ? input.storeId === null : input.userId === null) {
      return { kind: "invalid", message: wantsStore ? "storeId is required" : "userId is required" };
    }
    const owner = wantsStore ? input.storeId : input.userId;
    // The stored owner must be the party the document is addressed to (goods receipts: the issuing store).
    const party = document.kind === "seller_goods_ereceipt" ? document.issuer : document.recipient;
    if (party.refId !== owner) {
      return { kind: "invalid", message: `${wantsStore ? "storeId" : "userId"} must equal ${document.kind === "seller_goods_ereceipt" ? "issuer" : "recipient"}.refId` };
    }
    const id = this.d.ids.uuidV7();
    const outcome = await this.d.documents.createWithSubmission(
      { id, document, storeId: wantsStore ? input.storeId : null, userId: wantsStore ? null : input.userId, createdAtMs: now },
      {
        documentId: id,
        internalId: document.internalId,
        state: "QUEUED",
        attempts: 0,
        maxAttempts: this.d.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        nextAttemptAtMs: now,
        lastSubmittedAtMs: null,
        lastError: null,
        etaUuid: null,
        signedDocumentRef: null,
        rejectionReasons: null,
        version: 0,
        createdAtMs: now,
        decidedAtMs: null,
      },
    );
    if (outcome.kind === "created") {
      await this.d.events.publish({ type: "tax_document.issued", internalId: document.internalId, kind: document.kind });
    }
    return { kind: "ok", value: outcome.value, duplicate: outcome.kind === "duplicate" };
  }
}

export interface QueueRunSummary {
  readonly attempted: number;
  readonly accepted: number;
  readonly pending: number;
  readonly rejected: number;
  readonly retried: number;
  readonly deadLettered: number;
  /** Lost the compare-and-set to another worker: nothing was sent. */
  readonly skipped: number;
}

const EMPTY: QueueRunSummary = { attempted: 0, accepted: 0, pending: 0, rejected: 0, retried: 0, deadLettered: 0, skipped: 0 };

function advance(rec: SubmissionRecord, event: SubmissionEvent, attempts: number): SubmissionState {
  return submissionMachine.transition(rec.state, event, { attempts, maxAttempts: rec.maxAttempts });
}

/**
 * Drains due submissions (QUEUED and RETRY). Order of effects per document:
 *   1. CAS to SUBMITTED with attempts+1 (persisted BEFORE the call, so a crash leaves a
 *      SUBMITTED row that the status poller resolves; ETA is idempotent on the internal id),
 *   2. call ETA,
 *   3. CAS to ACCEPTED / REJECTED / RETRY (backoff + jitter) / DEAD_LETTER (DLQ).
 */
export class ProcessSubmissionQueue {
  constructor(private readonly d: TaxEtaDeps) {}

  async execute(limit = 50): Promise<QueueRunSummary> {
    let s = { ...EMPTY };
    const due = await this.d.documents.listDue(this.d.clock.nowMs(), limit);
    for (const item of due) {
      const sub = item.submission;
      const attempts = sub.attempts + 1;
      const now = this.d.clock.nowMs();
      const sending: SubmissionRecord = {
        ...sub,
        state: advance(sub, "SUBMIT", attempts),
        attempts,
        lastSubmittedAtMs: now,
        version: sub.version + 1,
      };
      if (!(await this.d.documents.updateSubmission(sending, sub.version))) {
        s = { ...s, skipped: s.skipped + 1 };
        continue;
      }
      s = { ...s, attempted: s.attempted + 1 };
      let result;
      try {
        result = await this.d.eta.submit(item.stored.document);
      } catch (e) {
        result = { kind: "transient_error" as const, message: e instanceof Error ? e.message : "eta_call_failed" };
      }
      s = await this.settle(item, sending, result, s);
    }
    return s;
  }

  private async settle(
    item: DocumentWithSubmission,
    sending: SubmissionRecord,
    result: Awaited<ReturnType<EtaPort["submit"]>>,
    s: QueueRunSummary,
  ): Promise<QueueRunSummary> {
    const now = this.d.clock.nowMs();
    const doc = item.stored.document;
    switch (result.kind) {
      case "accepted": {
        const stored = await this.d.signed.put(doc.internalId, result.signed);
        await this.save(sending, {
          state: advance(sending, "ACCEPT", sending.attempts),
          etaUuid: result.etaUuid,
          signedDocumentRef: stored.ref,
          lastError: null,
          decidedAtMs: now,
        });
        await this.d.events.publish({ type: "eta.submission_accepted", internalId: doc.internalId, etaUuid: result.etaUuid });
        return { ...s, accepted: s.accepted + 1 };
      }
      case "rejected": {
        await this.save(sending, {
          state: advance(sending, "REJECT", sending.attempts),
          rejectionReasons: result.reasons.slice(0, 20).map((r) => r.slice(0, 300)),
          decidedAtMs: now,
        });
        await this.d.events.publish({ type: "eta.submission_rejected", internalId: doc.internalId, reasons: result.reasons.slice(0, 20) });
        return { ...s, rejected: s.rejected + 1 };
      }
      case "pending":
        await this.save(sending, { etaUuid: result.etaUuid });
        return { ...s, pending: s.pending + 1 };
      case "transient_error": {
        const message = result.message.slice(0, 500);
        if (sending.attempts >= sending.maxAttempts) {
          await this.save(sending, { state: advance(sending, "EXHAUST", sending.attempts), lastError: message, decidedAtMs: null });
          await this.d.events.publish({ type: "eta.submission_dead_lettered", internalId: doc.internalId });
          return { ...s, deadLettered: s.deadLettered + 1 };
        }
        const delay = backoffDelayMs(sending.attempts, random01(this.d.ids), this.d.backoff ?? DEFAULT_BACKOFF);
        await this.save(sending, { state: advance(sending, "FAIL", sending.attempts), lastError: message, nextAttemptAtMs: now + delay });
        return { ...s, retried: s.retried + 1 };
      }
    }
  }

  private async save(current: SubmissionRecord, patch: Partial<SubmissionRecord>): Promise<void> {
    const next: SubmissionRecord = { ...current, ...patch, version: current.version + 1 };
    // A lost CAS here means another worker (the poller) already decided this row; their result stands.
    await this.d.documents.updateSubmission(next, current.version);
  }
}

/** Resolves SUBMITTED rows (pending at ETA, or stranded by a crash) by polling ETA status. */
export class PollSubmissionStatuses {
  constructor(private readonly d: TaxEtaDeps) {}

  async execute(input: { readonly minAgeMs: number; readonly limit?: number }): Promise<QueueRunSummary> {
    let s = { ...EMPTY };
    const now = this.d.clock.nowMs();
    const rows = await this.d.documents.listAwaitingStatus(now - input.minAgeMs, input.limit ?? 50);
    for (const item of rows) {
      const sub = item.submission;
      let r;
      try {
        r = await this.d.eta.status(sub.internalId);
      } catch {
        r = { kind: "transient_error" as const, message: "poll_failed" };
      }
      s = { ...s, attempted: s.attempted + 1 };
      if (r.kind === "accepted") {
        const stored = await this.d.signed.put(sub.internalId, r.signed);
        const next: SubmissionRecord = {
          ...sub,
          state: advance(sub, "ACCEPT", sub.attempts),
          etaUuid: r.etaUuid,
          signedDocumentRef: stored.ref,
          decidedAtMs: now,
          version: sub.version + 1,
        };
        if (await this.d.documents.updateSubmission(next, sub.version)) {
          await this.d.events.publish({ type: "eta.submission_accepted", internalId: sub.internalId, etaUuid: r.etaUuid });
          s = { ...s, accepted: s.accepted + 1 };
        } else s = { ...s, skipped: s.skipped + 1 };
      } else if (r.kind === "rejected") {
        const next: SubmissionRecord = {
          ...sub,
          state: advance(sub, "REJECT", sub.attempts),
          rejectionReasons: r.reasons.slice(0, 20).map((x) => x.slice(0, 300)),
          decidedAtMs: now,
          version: sub.version + 1,
        };
        if (await this.d.documents.updateSubmission(next, sub.version)) {
          await this.d.events.publish({ type: "eta.submission_rejected", internalId: sub.internalId, reasons: r.reasons.slice(0, 20) });
          s = { ...s, rejected: s.rejected + 1 };
        } else s = { ...s, skipped: s.skipped + 1 };
      } else if (r.kind === "not_found") {
        // ETA never received it (crash between persist and call): send it again through the retry path.
        const next: SubmissionRecord = {
          ...sub,
          state: sub.attempts >= sub.maxAttempts ? advance(sub, "EXHAUST", sub.attempts) : advance(sub, "FAIL", sub.attempts),
          lastError: "not_found_at_eta",
          nextAttemptAtMs: now,
          version: sub.version + 1,
        };
        if (await this.d.documents.updateSubmission(next, sub.version)) s = { ...s, retried: s.retried + 1 };
        else s = { ...s, skipped: s.skipped + 1 };
      } else {
        s = { ...s, pending: s.pending + 1 };
      }
    }
    return s;
  }
}

/** A day report plus whether the tax authority was actually queried (B-3, F-2). */
export interface CheckedReconciliation {
  readonly report: ReconciliationReport;
  /** False when ETA was Unconfigured or failed: only internal checks ran, so `report.reconciled` must not be shown as "reconciled". */
  readonly authorityChecked: boolean;
}

/** Longest range one call may cover (Cairo days). */
export const MAX_RECONCILIATION_RANGE_DAYS = 31;

/** Small TTL cache for ETA day reports of PAST Cairo days (immutable once the day is over). In-process. */
export class DayReportCache {
  private readonly m = new Map<string, { at: number; v: readonly EtaReportedItem[] }>();
  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly max = 64,
  ) {}
  get(key: string, nowMs: number): readonly EtaReportedItem[] | null {
    const e = this.m.get(key);
    if (e === undefined || nowMs - e.at > this.ttlMs) return null;
    return e.v;
  }
  set(key: string, nowMs: number, v: readonly EtaReportedItem[]): void {
    if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value as string);
    this.m.set(key, { at: nowMs, v });
  }
}

export class RunDailyReconciliation {
  private readonly cache = new DayReportCache();
  constructor(private readonly d: TaxEtaDeps) {}

  /** `date` is a Cairo calendar day (YYYY-MM-DD). Throws a DomainError on a malformed date. */
  async execute(date: string): Promise<ReconciliationReport> {
    return (await this.check(date)).report;
  }

  async check(date: string): Promise<CheckedReconciliation> {
    const { startMs, endMs } = cairoDayWindow(date);
    const rows = await this.d.documents.listIssuedBetween(startMs, endMs);
    const nowMs = this.d.clock.nowMs();
    // A day that has fully passed cannot change at the authority, so its report may be served from the TTL cache.
    const past = endMs <= nowMs;
    const cached = past ? this.cache.get(date, nowMs) : null;
    const etaReport =
      cached ??
      (await this.d.eta.dayReport(startMs, endMs).catch((e: unknown) => {
        // Class name only: never the message, which may carry provider detail.
        process.stdout.write(`${JSON.stringify({ level: "warn", event: "tax.eta_day_report_failed", error: e instanceof Error ? e.constructor.name : "unknown" })}\n`);
        return null;
      }));
    if (past && cached === null && etaReport !== null) this.cache.set(date, nowMs, etaReport);
    const report = reconcileDay({
      date,
      nowMs,
      etaReport,
      submissions: rows.map((r) => ({
        internalId: r.submission.internalId,
        state: r.submission.state,
        gross: r.stored.document.totals.gross.amount,
        etaUuid: r.submission.etaUuid,
        signedDocumentRef: r.submission.signedDocumentRef,
        lastSubmittedAtMs: r.submission.lastSubmittedAtMs,
      })),
    });
    return { report, authorityChecked: etaReport !== null };
  }

  /** Inclusive Cairo-day range, ascending, at most MAX_RECONCILIATION_RANGE_DAYS. Throws a DomainError when invalid. */
  async checkRange(from: string, to: string): Promise<readonly CheckedReconciliation[]> {
    cairoDayWindow(from);
    cairoDayWindow(to);
    const days: string[] = [];
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
      days.push(new Date(t).toISOString().slice(0, 10));
      if (days.length > MAX_RECONCILIATION_RANGE_DAYS) throw new DomainError("range too long");
    }
    if (days.length === 0) throw new DomainError("from is after to");
    const out: CheckedReconciliation[] = [];
    for (const day of days) out.push(await this.check(day));
    return out;
  }
}

export type ChangeExemptionResult =
  | { readonly kind: "ok"; readonly category: TaxCategory }
  | { readonly kind: "not_found" }
  | { readonly kind: "conflict" }
  | { readonly kind: "invalid"; readonly message: string };

export class ChangeExemption {
  constructor(private readonly d: TaxEtaDeps) {}

  async execute(input: {
    readonly code: string;
    readonly change: ExemptionChange;
    readonly actorId: string;
    readonly expectedVersion: number;
  }): Promise<ChangeExemptionResult> {
    const current = await this.d.config.getCategory(input.code);
    if (current === null) return { kind: "not_found" };
    if (current.version !== input.expectedVersion) return { kind: "conflict" };
    try {
      const { category, audit } = applyExemptionChange(current, input.change, input.actorId, this.d.clock.nowMs());
      const saved = await this.d.config.saveCategoryWithAudit(category, audit);
      if (saved === "conflict") return { kind: "conflict" };
      if (saved === "not_found") return { kind: "not_found" };
      return { kind: "ok", category };
    } catch (e) {
      if (e instanceof DomainError) return { kind: "invalid", message: e.message };
      throw e;
    }
  }
}

export class RequeueDeadLetter {
  constructor(private readonly d: TaxEtaDeps) {}

  async execute(documentId: string): Promise<"ok" | "not_found" | "invalid_state" | "conflict"> {
    const item = await this.d.documents.findById(documentId);
    if (item === null) return "not_found";
    const sub = item.submission;
    if (sub.state !== "DEAD_LETTER") return "invalid_state";
    const next: SubmissionRecord = {
      ...sub,
      state: advance(sub, "REQUEUE", sub.attempts),
      attempts: 0,
      nextAttemptAtMs: this.d.clock.nowMs(),
      lastError: null,
      version: sub.version + 1,
    };
    return (await this.d.documents.updateSubmission(next, sub.version)) ? "ok" : "conflict";
  }
}

export class ListTaxCategories {
  constructor(private readonly d: TaxEtaDeps) {}
  execute() {
    return this.d.config.listCategories();
  }
}

export class ListExemptionAudit {
  constructor(private readonly d: TaxEtaDeps) {}
  execute(code: string | null, limit: number) {
    return this.d.config.listAudit(code, limit);
  }
}

export type ListResult = { readonly kind: "ok"; readonly page: Page<DocumentWithSubmission> } | { readonly kind: "invalid_cursor" };

export class ListAdminDocuments {
  constructor(private readonly d: TaxEtaDeps) {}
  async execute(filter: AdminDocumentFilter, cursor: string | null, limit: number): Promise<ListResult> {
    const r = await this.d.documents.listAll(filter, cursor, limit);
    return r === "invalid_cursor" ? { kind: "invalid_cursor" } : { kind: "ok", page: r };
  }
}

/** Seller invoices: only e-invoices addressed to one of the caller's stores. Never another tenant's. */
export class ListSellerInvoices {
  constructor(private readonly d: TaxEtaDeps) {}
  async execute(storeIds: readonly string[], cursor: string | null, limit: number): Promise<ListResult> {
    if (storeIds.length === 0) return { kind: "ok", page: { items: [], nextCursor: null } };
    const r = await this.d.documents.listForStores(storeIds, ["seller_einvoice"], cursor, limit);
    return r === "invalid_cursor" ? { kind: "invalid_cursor" } : { kind: "ok", page: r };
  }
}

export class GetSellerInvoice {
  constructor(private readonly d: TaxEtaDeps) {}
  async execute(storeIds: readonly string[], documentId: string): Promise<DocumentWithSubmission | null> {
    const item = await this.d.documents.findById(documentId);
    if (item === null || item.stored.storeId === null || !storeIds.includes(item.stored.storeId)) return null;
    if (item.stored.document.kind !== "seller_einvoice") return null;
    return item;
  }
}

export class GetAdminDocument {
  constructor(private readonly d: TaxEtaDeps) {}
  execute(documentId: string) {
    return this.d.documents.findById(documentId);
  }
}
