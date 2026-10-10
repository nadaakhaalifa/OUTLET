import { hmacSha256, toHex, utf8 } from "@outlet/auth-core";
import type { ConsentHistory, ConsentRecord, Hasher } from "@outlet/privacy";
import { ERASURE_PARKED_CODE } from "../domain/bridge";
import type {
  BreachEntry,
  DeletionRequest,
  DeletionSnapshot,
  ErasurePlan,
  ExportRequest,
  ExporterDescriptor,
  PrivacyRequest,
} from "../domain/bridge";
import type {
  BlockersPort,
  BreachRepository,
  ConsentRepository,
  ErasureExecutorPort,
  ExportRow,
  ExportSection,
  ExporterPort,
  InsertOutcome,
  ObjectStorePort,
  OutboxDraft,
  PrivacyRequestRepository,
  SignedUrl,
  UpdateOutcome,
} from "../domain/ports";

/** DEVELOPMENT FIXTURE: collects outbox drafts in memory, standing in for outbox_events. */
export class InMemoryPrivacyOutbox {
  readonly events: OutboxDraft[] = [];

  /** Rejects duplicate event ids BEFORE state is touched, mirroring outbox_events' primary key. */
  assertFresh(events: readonly OutboxDraft[]): void {
    const seen = new Set(this.events.map((e) => e.id));
    for (const e of events) {
      if (seen.has(e.id)) throw new Error(`duplicate outbox event ${e.id}`);
      seen.add(e.id);
    }
  }
}

/** DEVELOPMENT FIXTURE: in-memory append-only consent log, lost on restart. */
export class InMemoryConsentRepository implements ConsentRepository {
  private readonly log: ConsentRecord[] = [];
  constructor(private readonly outbox: InMemoryPrivacyOutbox = new InMemoryPrivacyOutbox()) {}

  async history(userId: string): Promise<ConsentHistory> {
    return this.log.filter((r) => r.userId === userId);
  }
  async append(records: readonly ConsentRecord[], events: readonly OutboxDraft[]): Promise<void> {
    this.outbox.assertFresh(events);
    this.log.push(...records);
    this.outbox.events.push(...events);
  }
}

/** Keyed hash of the client IP (HMAC-SHA-256, hex). The raw IP is never stored. */
export function createIpHasher(key: Uint8Array): Hasher {
  return (input) => toHex(hmacSha256(key, utf8(`ip:v1:${input}`)));
}

const OPEN_EXPORT = new Set(["requested", "collecting", "ready"]);
const OPEN_DELETE = new Set(["cooling", "on_hold", "erasing"]);

/** DEVELOPMENT FIXTURE. Same observable behaviour as the Kysely adapter (shared contract suite). */
export class InMemoryPrivacyRequestRepository implements PrivacyRequestRepository {
  private readonly rows = new Map<string, PrivacyRequest>();
  constructor(private readonly outbox: InMemoryPrivacyOutbox = new InMemoryPrivacyOutbox()) {}

  private open(userId: string, kind: PrivacyRequest["kind"]): PrivacyRequest | undefined {
    const set = kind === "export" ? OPEN_EXPORT : OPEN_DELETE;
    for (const r of this.rows.values()) if (r.userId === userId && r.kind === kind && set.has(r.status)) return r;
    return undefined;
  }

  async insertExport(request: ExportRequest, events: readonly OutboxDraft[]): Promise<InsertOutcome<ExportRequest>> {
    const existing = this.open(request.userId, "export");
    if (existing !== undefined && existing.kind === "export") return { kind: "existing", request: existing };
    this.outbox.assertFresh(events);
    this.rows.set(request.id, request);
    this.outbox.events.push(...events);
    return { kind: "created", request };
  }

  async insertDeletion(request: DeletionRequest, events: readonly OutboxDraft[]): Promise<InsertOutcome<DeletionRequest>> {
    const existing = this.open(request.userId, "delete");
    if (existing !== undefined && existing.kind === "delete") return { kind: "existing", request: existing };
    this.outbox.assertFresh(events);
    this.rows.set(request.id, request);
    this.outbox.events.push(...events);
    return { kind: "created", request };
  }

  async get(id: string): Promise<PrivacyRequest | null> {
    return this.rows.get(id) ?? null;
  }

  findLatest(userId: string, kind: "export"): Promise<ExportRequest | null>;
  findLatest(userId: string, kind: "delete"): Promise<DeletionRequest | null>;
  async findLatest(userId: string, kind: "export" | "delete"): Promise<ExportRequest | DeletionRequest | null> {
    const open = this.open(userId, kind);
    if (open !== undefined && open.kind === kind) return open;
    const all = [...this.rows.values()]
      .filter((r) => r.userId === userId && r.kind === kind)
      .sort((a, b) => b.requestedAtMs - a.requestedAtMs || b.updatedAtMs - a.updatedAtMs || (a.id < b.id ? 1 : -1));
    const first = all[0];
    return first === undefined ? null : first;
  }

  async update(next: PrivacyRequest, events: readonly OutboxDraft[]): Promise<UpdateOutcome> {
    const stored = this.rows.get(next.id);
    if (stored === undefined) return "not_found";
    if (stored.version !== next.version - 1 || stored.kind !== next.kind || stored.userId !== next.userId) return "conflict";
    this.outbox.assertFresh(events);
    this.rows.set(next.id, next);
    this.outbox.events.push(...events);
    return "ok";
  }

  private all(): PrivacyRequest[] {
    return [...this.rows.values()].sort((a, b) => a.requestedAtMs - b.requestedAtMs || (a.id < b.id ? -1 : 1));
  }

  async listPendingExports(limit: number): Promise<readonly ExportRequest[]> {
    return this.all()
      .filter((r): r is ExportRequest => r.kind === "export" && r.status === "requested")
      .slice(0, limit);
  }

  async listExpiredExports(nowMs: number, limit: number): Promise<readonly ExportRequest[]> {
    return this.all()
      .filter(
        (r): r is ExportRequest =>
          r.kind === "export" && r.status === "ready" && r.artifactExpiresAtMs !== null && r.artifactExpiresAtMs <= nowMs,
      )
      .slice(0, limit);
  }

  async listDueDeletions(nowMs: number, limit: number): Promise<readonly DeletionRequest[]> {
    return this.all()
      .filter(
        (r): r is DeletionRequest =>
          r.kind === "delete" &&
          r.failureCode !== ERASURE_PARKED_CODE &&
          (r.status === "erasing" || ((r.status === "cooling" || r.status === "on_hold") && r.coolingEndsAtMs <= nowMs)),
      )
      .slice(0, limit);
  }

  async listForQueue(limit: number): Promise<readonly PrivacyRequest[]> {
    return this.all()
      .filter((r) => (r.kind === "export" ? OPEN_EXPORT : OPEN_DELETE).has(r.status))
      .slice(0, limit);
  }

  async listRecentClosed(limit: number): Promise<readonly PrivacyRequest[]> {
    return this.all()
      .filter((r) => !(r.kind === "export" ? OPEN_EXPORT : OPEN_DELETE).has(r.status))
      .reverse()
      .slice(0, limit);
  }

  async listExportsForUser(userId: string): Promise<readonly ExportRequest[]> {
    return this.all().filter((r): r is ExportRequest => r.kind === "export" && r.userId === userId);
  }
}

/** DEVELOPMENT FIXTURE. */
export class InMemoryBreachRepository implements BreachRepository {
  private readonly rows = new Map<string, BreachEntry>();
  constructor(private readonly outbox: InMemoryPrivacyOutbox = new InMemoryPrivacyOutbox()) {}

  async insert(entry: BreachEntry, events: readonly OutboxDraft[]): Promise<void> {
    if (this.rows.has(entry.id)) throw new Error(`breach ${entry.id} already exists`);
    this.outbox.assertFresh(events);
    this.rows.set(entry.id, entry);
    this.outbox.events.push(...events);
  }
  async get(id: string): Promise<BreachEntry | null> {
    return this.rows.get(id) ?? null;
  }
  async update(next: BreachEntry, events: readonly OutboxDraft[]): Promise<UpdateOutcome> {
    const stored = this.rows.get(next.id);
    if (stored === undefined) return "not_found";
    if (stored.version !== next.version - 1) return "conflict";
    this.outbox.assertFresh(events);
    this.rows.set(next.id, next);
    this.outbox.events.push(...events);
    return "ok";
  }
  async list(limit: number): Promise<readonly BreachEntry[]> {
    return [...this.rows.values()]
      .sort((a, b) => b.detectedAtMs - a.detectedAtMs || (a.id < b.id ? -1 : 1))
      .slice(0, limit);
  }
}

/** FAKE for tests and dev: the real adapter reads orders, returns, disputes and wallet modules. */
export class FakeBlockers implements BlockersPort {
  private readonly byUser = new Map<string, DeletionSnapshot>();
  set(userId: string, snapshot: Partial<DeletionSnapshot>): void {
    this.byUser.set(userId, { openOrders: 0, openReturns: 0, openDisputes: 0, storeCreditMinor: 0n, ...snapshot });
  }
  async snapshot(userId: string): Promise<DeletionSnapshot> {
    return this.byUser.get(userId) ?? { openOrders: 0, openReturns: 0, openDisputes: 0, storeCreditMinor: 0n };
  }
}

/** DEVELOPMENT FIXTURE: in-memory object store with HMAC-signed, expiring URLs. */
export class InMemoryObjectStore implements ObjectStorePort {
  private readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  constructor(
    private readonly signingKey: Uint8Array,
    private readonly baseUrl: string = "https://exports.invalid",
  ) {
    InMemoryObjectStore.instances.add(new WeakRef(this));
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { bytes, contentType });
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  /** Dev-fixture registry so the fake erasure executor can reach every in-memory store. */
  static readonly instances = new Set<WeakRef<InMemoryObjectStore>>();
  static deleteEverywhere(key: string): void {
    for (const ref of InMemoryObjectStore.instances) {
      const s = ref.deref();
      if (s === undefined) InMemoryObjectStore.instances.delete(ref);
      else s.objects.delete(key);
    }
  }
  async signGetUrl(key: string, ttlSeconds: number, nowMs: number): Promise<SignedUrl> {
    const expiresAtMs = nowMs + ttlSeconds * 1000;
    const sig = toHex(hmacSha256(this.signingKey, utf8(`${key}:${expiresAtMs}`)));
    return { url: `${this.baseUrl}/${encodeURI(key)}?exp=${expiresAtMs}&sig=${sig}`, expiresAtMs };
  }
  has(key: string): boolean {
    return this.objects.has(key);
  }
  bytes(key: string): Uint8Array | undefined {
    return this.objects.get(key)?.bytes;
  }
  get size(): number {
    return this.objects.size;
  }
}

export interface ErasureCall {
  readonly userId: string;
  readonly pseudonym: string;
  readonly plan: ErasurePlan;
  readonly artifactKeys?: readonly string[];
}

/** FAKE: records calls; can be told to fail to exercise crash and resume. */
export class RecordingErasureExecutor implements ErasureExecutorPort {
  readonly calls: ErasureCall[] = [];
  failNext = false;
  async execute(input: ErasureCall): Promise<void> {
    this.calls.push(input);
    // Same contract as a real executor: artifacts are removed as part of the erasure.
    for (const key of input.artifactKeys ?? []) InMemoryObjectStore.deleteEverywhere(key);
    if (this.failNext) {
      this.failNext = false;
      throw new Error("erasure failed");
    }
  }
}

/** FAKE exporter: serves seeded rows for its declared tables, empty otherwise. */
export class FakeExporter implements ExporterPort {
  readonly key: string;
  readonly tables: readonly string[];
  private readonly seeded = new Map<string, Map<string, readonly ExportRow[]>>();
  failWith: Error | null = null;
  constructor(descriptor: ExporterDescriptor) {
    this.key = descriptor.key;
    this.tables = descriptor.tables;
  }
  seed(userId: string, table: string, rows: readonly ExportRow[]): void {
    const perUser = this.seeded.get(userId) ?? new Map<string, readonly ExportRow[]>();
    perUser.set(table, rows);
    this.seeded.set(userId, perUser);
  }
  async collect(userId: string): Promise<ExportSection> {
    if (this.failWith !== null) throw this.failWith;
    const perUser = this.seeded.get(userId);
    return { tables: Object.fromEntries(this.tables.map((t) => [t, perUser?.get(t) ?? []])) };
  }
}
