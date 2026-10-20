import {
  FakeRanker,
  LinearRanker,
  scoreNextItems,
  type RankerModel,
  type RankingFeatureVector,
  type SessionEvent,
  type TransitionModel,
} from "../domain/bridge";
import type {
  EvalRunRecord,
  EvalRunStore,
  FlagPort,
  ModelRegistryPort,
  RankerV2Port,
  SessionNextItemPort,
  ShadowItemRecord,
  ShadowLogStore,
  ShadowRunRecord,
  ShadowSummary,
} from "../domain/ports";

/** Wraps a pure domain model. This is also the production default (a linear model needs no service). */
export class DomainModelRanker implements RankerV2Port {
  constructor(private readonly model: RankerModel) {}
  get modelVersion(): string {
    return this.model.modelVersion;
  }
  async score(batch: readonly RankingFeatureVector[]): Promise<readonly number[]> {
    return this.model.score(batch);
  }
}

export class ThrowingRanker implements RankerV2Port {
  readonly modelVersion = "throwing";
  async score(): Promise<readonly number[]> {
    throw new Error("ranker down");
  }
}

export class StaticRankingFlags implements FlagPort {
  constructor(public allowed = true) {}
  async shadowAllowed(): Promise<boolean> {
    return this.allowed;
  }
}

export class StaticModelRegistry implements ModelRegistryPort {
  private readonly m = new Map<string, RankerModel>();
  constructor(models: readonly RankerModel[] = defaultModels()) {
    for (const x of models) this.m.set(x.modelVersion, x);
  }
  names(): readonly string[] {
    return [...this.m.keys()].sort();
  }
  get(name: string): RankerModel | null {
    return this.m.get(name) ?? null;
  }
}

export function defaultModels(): RankerModel[] {
  return [
    new LinearRanker(),
    new LinearRanker("popularity-baseline", { popularity: 1, freshness: 1 }),
    new FakeRanker(),
  ];
}

/** Deterministic stand-in for the sequence model: delegates to the pure transition model. */
export class FakeSessionModel implements SessionNextItemPort {
  readonly calls: { session: readonly SessionEvent[]; candidateIds: readonly string[] }[] = [];
  constructor(private readonly model: TransitionModel, readonly modelVersion = "fake-session-v1") {}
  async nextItemScores(session: readonly SessionEvent[], candidateIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    this.calls.push({ session, candidateIds });
    return scoreNextItems(this.model, session, candidateIds);
  }
}

export class InMemoryShadowLogStore implements ShadowLogStore {
  readonly runs: ShadowRunRecord[] = [];
  readonly items = new Map<string, readonly ShadowItemRecord[]>();
  async record(run: ShadowRunRecord, items: readonly ShadowItemRecord[]): Promise<void> {
    this.runs.push(run);
    this.items.set(run.id, items);
  }
  async itemsOf(runId: string): Promise<readonly ShadowItemRecord[]> {
    return [...(this.items.get(runId) ?? [])].sort((a, b) => a.v2Rank - b.v2Rank);
  }
  async summary(sinceMs: number): Promise<ShadowSummary> {
    const r = this.runs.filter((x) => x.createdAtMs >= sinceMs);
    const mean = (f: (x: ShadowRunRecord) => number): number | null =>
      r.length === 0 ? null : Math.round(r.reduce((s, x) => s + f(x), 0) / r.length);
    return {
      runs: r.length,
      personalizedRuns: r.filter((x) => x.personalized).length,
      botFilteredRuns: r.filter((x) => x.botFiltered).length,
      meanOverlapPermille: mean((x) => x.overlapPermille),
      top1SamePermille: r.length === 0 ? null : Math.round((r.filter((x) => x.top1Same).length * 1000) / r.length),
      meanRankShiftMilli: mean((x) => x.meanRankShiftMilli),
      shadowModelVersions: [...new Set(r.map((x) => x.shadowModelVersion))].sort(),
    };
  }
  async purgeBefore(beforeMs: number): Promise<number> {
    const old = this.runs.filter((x) => x.createdAtMs < beforeMs);
    for (const o of old) this.items.delete(o.id);
    const keep = this.runs.filter((x) => x.createdAtMs >= beforeMs);
    this.runs.length = 0;
    this.runs.push(...keep);
    return old.length;
  }
}

export class InMemoryEvalRunStore implements EvalRunStore {
  private readonly rows: EvalRunRecord[] = [];
  async insert(run: EvalRunRecord): Promise<{ run: EvalRunRecord; created: boolean }> {
    const existing = this.rows.find((r) => r.requestKey === run.requestKey);
    if (existing !== undefined) return { run: existing, created: false };
    this.rows.push(run);
    return { run, created: true };
  }
  async list(limit: number): Promise<readonly EvalRunRecord[]> {
    return [...this.rows].sort((a, b) => b.createdAtMs - a.createdAtMs || (a.id < b.id ? 1 : -1)).slice(0, limit);
  }
}
