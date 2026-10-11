import type { BlobDeletePort, PurgeCount, PurgeExecutor, PurgeRunRecord, PurgeRunStore, PurgeTarget, RetentionMetrics } from "../domain/ports";

export interface FakeRow {
  readonly id: string;
  readonly atMs: number;
  /** Row's owner is under a legal hold. */
  readonly held?: boolean;
  /** Fails the target's state guard (open dispute, still ACTIVE, ...). */
  readonly guarded?: boolean;
  readonly blobRef?: string;
}

/** Fake executor with the same observable rules as the SQL one: strictly older than the cutoff, unheld, unguarded. */
export class InMemoryPurgeExecutor implements PurgeExecutor {
  private readonly rows = new Map<string, FakeRow[]>();
  readonly deleted: string[] = [];
  readonly batchCalls: number[] = [];
  failOn: string | null = null;

  constructor(private readonly blobs?: BlobDeletePort) {}

  seed(targetId: string, rows: readonly FakeRow[]): void {
    this.rows.set(targetId, [...(this.rows.get(targetId) ?? []), ...rows]);
  }
  remaining(targetId: string): readonly FakeRow[] {
    return this.rows.get(targetId) ?? [];
  }

  private eligibleRows(t: PurgeTarget, cutoffMs: number): FakeRow[] {
    return (this.rows.get(t.id) ?? []).filter((r) => r.atMs < cutoffMs && r.guarded !== true);
  }

  async count(t: PurgeTarget, cutoffMs: number): Promise<PurgeCount> {
    const el = this.eligibleRows(t, cutoffMs);
    const free = el.filter((r) => r.held !== true);
    return { eligible: free.length, held: el.length - free.length, oldestEligibleMs: free.length === 0 ? null : Math.min(...free.map((r) => r.atMs)) };
  }

  async purgeBatch(t: PurgeTarget, cutoffMs: number, limit: number): Promise<number> {
    if (this.failOn === t.id) throw new Error("boom");
    const pick = this.eligibleRows(t, cutoffMs).filter((r) => r.held !== true).slice(0, limit);
    this.batchCalls.push(pick.length);
    if (pick.length === 0) return 0;
    const refs = pick.flatMap((r) => (r.blobRef === undefined ? [] : [r.blobRef]));
    if (t.blobColumn !== undefined && refs.length > 0) await this.blobs?.deleteMany(refs);
    const ids = new Set(pick.map((r) => r.id));
    this.rows.set(t.id, (this.rows.get(t.id) ?? []).filter((r) => !ids.has(r.id)));
    this.deleted.push(...ids);
    return pick.length;
  }
}

export class InMemoryBlobDelete implements BlobDeletePort {
  readonly deleted: string[] = [];
  async deleteMany(refs: readonly string[]): Promise<void> {
    this.deleted.push(...refs);
  }
}

export class InMemoryRunStore implements PurgeRunStore {
  private readonly runs = new Map<string, PurgeRunRecord>();
  async start(r: Pick<PurgeRunRecord, "id" | "ruleId" | "targetId" | "dryRun" | "cutoffMs" | "startedMs">): Promise<void> {
    this.runs.set(r.id, { ...r, finishedMs: null, status: "RUNNING", rowsPurged: 0, rowsEligible: null, rowsHeld: 0, batches: 0, oldestEligibleMs: null, errorCode: null });
  }
  async finish(id: string, f: Parameters<PurgeRunStore["finish"]>[1]): Promise<void> {
    const cur = this.runs.get(id);
    if (cur !== undefined) this.runs.set(id, { ...cur, ...f });
  }
  async list(ruleId?: string): Promise<readonly PurgeRunRecord[]> {
    return [...this.runs.values()].filter((r) => ruleId === undefined || r.ruleId === ruleId);
  }
}

export class RecordingMetrics implements RetentionMetrics {
  readonly counters: { name: string; value: number; labels: Readonly<Record<string, string>> }[] = [];
  readonly gauges: { name: string; value: number; labels: Readonly<Record<string, string>> }[] = [];
  counter(name: string, value: number, labels: Readonly<Record<string, string>>): void {
    this.counters.push({ name, value, labels });
  }
  gauge(name: string, value: number, labels: Readonly<Record<string, string>>): void {
    this.gauges.push({ name, value, labels });
  }
}

/** Structured JSON line per metric, same convention as the worker dead-man gauge (no metrics exporter yet). */
export class LogRetentionMetrics implements RetentionMetrics {
  constructor(private readonly write: (line: string) => void = (l) => process.stdout.write(`${l}\n`)) {}
  counter(name: string, value: number, labels: Readonly<Record<string, string>>): void {
    this.write(JSON.stringify({ level: "info", event: "retention.metric", kind: "counter", metric: name, value, ...labels }));
  }
  gauge(name: string, value: number, labels: Readonly<Record<string, string>>): void {
    this.write(JSON.stringify({ level: "info", event: "retention.metric", kind: "gauge", metric: name, value, ...labels }));
  }
}
