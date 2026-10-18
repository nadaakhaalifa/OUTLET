import { sellers } from "@outlet/domain";
import type {
  AggregateRow,
  ApplicationRow,
  BrandApplicationRepository,
  BrandDocumentStore,
  Commit,
  CommitResult,
  Cursor,
  DocumentRow,
  DomainVerificationState,
  AutoCheckSnapshot,
  VerificationLink,
  FunnelAnalyticsPort,
  FunnelEvent,
  HistoryDraft,
  HistoryRow,
  OutboxEventDraft,
  Page,
  RepoScope,
  ReviewQueueQuery,
  ScanPort,
  UploadTarget,
} from "../domain/ports";

const ACTIVE = new Set<string>(sellers.ACTIVE_STATUSES);
const cmp = (a: { createdAtMs: number; id: string }, b: { createdAtMs: number; id: string }): number =>
  b.createdAtMs - a.createdAtMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

interface Entry {
  app: ApplicationRow;
  docs: Map<string, DocumentRow>;
}

export class InMemoryBrandApplicationRepository implements BrandApplicationRepository {
  private readonly rows = new Map<string, Entry>();
  private readonly historyRows: HistoryRow[] = [];
  readonly outbox: OutboxEventDraft[] = [];

  private visible(e: Entry | undefined, scope: RepoScope): e is Entry {
    return e !== undefined && (scope.kind === "system" || e.app.applicantId === scope.applicantId);
  }

  private activeClash(app: ApplicationRow): boolean {
    if (!ACTIVE.has(app.status)) return false;
    for (const e of this.rows.values()) {
      if (e.app.id !== app.id && e.app.applicantId === app.applicantId && e.app.brandNameNorm === app.brandNameNorm && ACTIVE.has(e.app.status)) return true;
    }
    return false;
  }

  private agg(e: Entry): AggregateRow {
    return { app: e.app, documents: [...e.docs.values()].sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : 1)) };
  }

  async insert(row: ApplicationRow, history: HistoryDraft, events: readonly OutboxEventDraft[]): Promise<"created" | "duplicate_active"> {
    if (this.activeClash(row)) return "duplicate_active";
    this.rows.set(row.id, { app: row, docs: new Map() });
    this.historyRows.push({ ...history, applicationId: row.id });
    this.outbox.push(...events);
    return "created";
  }

  async get(id: string, scope: RepoScope): Promise<AggregateRow | null> {
    const e = this.rows.get(id);
    return this.visible(e, scope) ? this.agg(e) : null;
  }

  private page(rows: AggregateRow[], after: Cursor | null, limit: number): Page<AggregateRow> {
    const sorted = rows.sort((a, b) => cmp(a.app, b.app));
    const from = after === null ? sorted : sorted.filter((r) => cmp(r.app, after) > 0);
    const items = from.slice(0, limit);
    const last = items[items.length - 1];
    return { items, next: from.length > limit && last !== undefined ? { createdAtMs: last.app.createdAtMs, id: last.app.id } : null };
  }

  async listForApplicant(applicantId: string, after: Cursor | null, limit: number): Promise<Page<AggregateRow>> {
    return this.page([...this.rows.values()].filter((e) => e.app.applicantId === applicantId).map((e) => this.agg(e)), after, limit);
  }

  async lastRejectedAtMs(applicantId: string, norm: string): Promise<number | null> {
    let best: number | null = null;
    for (const e of this.rows.values()) {
      const r = e.app;
      if (r.applicantId === applicantId && r.brandNameNorm === norm && r.status === "REJECTED" && r.rejectedAtMs !== null) {
        best = best === null ? r.rejectedAtMs : Math.max(best, r.rejectedAtMs);
      }
    }
    return best;
  }

  async countDocumentsSince(applicationId: string, sinceMs: number): Promise<number> {
    const e = this.rows.get(applicationId);
    return e === undefined ? 0 : [...e.docs.values()].filter((d) => d.createdAtMs >= sinceMs).length;
  }

  async commit(c: Commit): Promise<CommitResult> {
    const e = this.rows.get(c.app.id);
    if (!this.visible(e, c.scope)) return "not_found";
    if (e.app.version !== c.expectedVersion || c.app.version !== c.expectedVersion + 1) return "conflict";
    if (this.activeClash(c.app)) return "duplicate_active";
    e.app = c.app;
    for (const d of c.documentsUpsert) e.docs.set(d.id, d);
    for (const id of c.documentsDelete) e.docs.delete(id);
    if (c.history !== null) this.historyRows.push({ ...c.history, applicationId: c.app.id });
    this.outbox.push(...c.events);
    return "ok";
  }

  async listForReview(q: ReviewQueueQuery): Promise<Page<AggregateRow>> {
    const rows = [...this.rows.values()]
      .filter((e) => {
        const a = e.app;
        if (a.status === "DRAFT" || a.status === "WITHDRAWN") return false;
        if (q.status !== undefined && a.status !== q.status) return false;
        if (q.kind !== undefined && a.brandKind !== q.kind) return false;
        if (q.country !== undefined && a.country !== q.country) return false;
        if (q.assigneeId === "unassigned" && a.assigneeId !== null) return false;
        if (q.assigneeId !== undefined && q.assigneeId !== "unassigned" && a.assigneeId !== q.assigneeId) return false;
        if (q.slaBreachedAtMs !== undefined && !(a.decisionDueAtMs !== null && a.decisionDueAtMs < q.slaBreachedAtMs && ["SUBMITTED", "AUTO_CHECKS", "IN_REVIEW"].includes(a.status))) return false;
        return true;
      })
      .map((e) => this.agg(e));
    return this.page(rows, q.after, q.limit);
  }

  async history(applicationId: string): Promise<readonly HistoryRow[]> {
    return this.historyRows.filter((h) => h.applicationId === applicationId).sort((a, b) => a.occurredAtMs - b.occurredAtMs);
  }

  async countOtherByNationalId(blind: Uint8Array, excludeId: string): Promise<number> {
    const hex = Buffer.from(blind).toString("hex");
    return [...this.rows.values()].filter((e) => e.app.id !== excludeId && e.app.nationalIdBlind !== null && Buffer.from(e.app.nationalIdBlind).toString("hex") === hex).length;
  }
}

// ----------------------------------------------------------------- development fakes

/** DEVELOPMENT FAKE: keeps objects in memory. A test hook uploads bytes; presigned URLs point at a fake host. */
export class FakeBrandDocumentStore implements BrandDocumentStore {
  readonly objects = new Map<string, Uint8Array>();
  constructor(private readonly nowMs: () => number = Date.now) {}

  async createUploadUrl(i: { key: string; contentType: string; ttlSeconds: number }): Promise<UploadTarget> {
    return {
      url: `https://uploads.fake.invalid/${i.key}`,
      method: "PUT",
      headers: { "Content-Type": i.contentType, "x-amz-server-side-encryption": "AES256" },
      expiresAtMs: this.nowMs() + i.ttlSeconds * 1000,
    };
  }
  /** Test helper: simulate the client PUT. */
  put(key: string, bytes: Uint8Array): void {
    this.objects.set(key, bytes);
  }
  async stat(key: string) {
    const b = this.objects.get(key);
    return b === undefined ? null : { sizeBytes: b.length, head: b.slice(0, 16) };
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async signReadUrl(key: string, ttlSeconds: number) {
    return { url: `https://read.fake.invalid/${key}?ttl=${ttlSeconds}`, expiresAtMs: this.nowMs() + ttlSeconds * 1000 };
  }
}

/** DEVELOPMENT FAKE: EICAR marker is infected, everything else clean. */
export class FakeScanPort implements ScanPort {
  constructor(private readonly store: FakeBrandDocumentStore) {}
  async scan(key: string): Promise<"clean" | "infected"> {
    const b = this.store.objects.get(key);
    return b !== undefined && Buffer.from(b).includes("EICAR-STANDARD-ANTIVIRUS-TEST-FILE") ? "infected" : "clean";
  }
}

/** DEVELOPMENT FAKE of the brand-verification link: tests set the domain state and read the checks that ran. */
export class FakeVerificationLink implements VerificationLink {
  readonly states = new Map<string, DomainVerificationState>();
  readonly checked: AutoCheckSnapshot[] = [];
  async domainState(applicationId: string): Promise<DomainVerificationState | null> {
    return this.states.get(applicationId) ?? null;
  }
  async runAutoChecks(snapshot: AutoCheckSnapshot): Promise<void> {
    this.checked.push(snapshot);
  }
}

export class RecordingFunnel implements FunnelAnalyticsPort {
  readonly events: FunnelEvent[] = [];
  track(e: FunnelEvent): void {
    this.events.push(e);
  }
}

/** Used in production until a consent-aware analytics sink is composed (events are dropped, never invented). */
export class NullFunnel implements FunnelAnalyticsPort {
  track(): void {}
}
