import {
  BOT_SCORE_THRESHOLD_PERMILLE,
  DEFAULT_GUARDRAIL_CONFIG,
  DEFAULT_REGRESSION_GATE,
  buildFeatureVector,
  checkRegression,
  compareShadow,
  evaluateGuardrails,
  evaluateRanker,
  generateSyntheticLogs,
  isBotRequest,
  seededRng,
  type ArmOutcome,
  type GuardrailConfig,
  type GuardrailResult,
} from "../domain/bridge";
import type {
  Clock,
  EvalRunRecord,
  EvalRunStore,
  FlagPort,
  IdPort,
  ModelRegistryPort,
  RankerV2Port,
  ShadowItemRecord,
  ShadowLogStore,
  ShadowObservation,
  ShadowObserverPort,
  ShadowSummary,
} from "../domain/ports";
import { FeatureVectorSchema } from "../domain/schemas";

export const SHADOW_LOG_TOP_N = 50;
export const SHADOW_COMPARE_K = 10;
export const MAX_EVAL_REQUESTS = 2_000;
export const SHADOW_RETENTION_DAYS = 30;

const bps = (x: number): number => Math.max(0, Math.min(10_000, Math.round(x * 10_000)));

/**
 * Shadow deployment: v1 is what the shopper already got; v2 only scores and logs. Every failure
 * (flag off, ranker down, schema violation, store error) is swallowed so serving is unaffected.
 * Requests that were not personalized reach this class with user = null and the feature builder
 * ignores the user object anyway, so no user feature is ever scored or stored for them.
 */
export class ShadowObserve implements ShadowObserverPort {
  constructor(
    private readonly ranker: RankerV2Port,
    private readonly store: ShadowLogStore,
    private readonly flags: FlagPort,
    private readonly clock: Clock,
    private readonly ids: IdPort,
  ) {}

  async observe(o: ShadowObservation): Promise<void> {
    try {
      if (!(await this.flags.shadowAllowed())) return;
      if (o.candidates.length === 0) return;
      const vectors = o.candidates.map((c) => buildFeatureVector(c, o.personalized ? o.user : null, o.personalized, o.nowMs, o.sizeLabels ?? null));
      for (const v of vectors) if (!FeatureVectorSchema.safeParse(v).success) return;
      const raw = await this.ranker.score(vectors);
      if (raw.length !== vectors.length) return;
      const scores = new Map<string, number>();
      vectors.forEach((v, i) => scores.set(v.productId, Number.isFinite(raw[i]) ? (raw[i] as number) : 0));
      const cmp = compareShadow(o.servedOrder, scores, SHADOW_COMPARE_K);
      const v2Order = [...scores.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => id);
      const v1Rank = new Map(o.servedOrder.map((id, i) => [id, i + 1]));
      const byId = new Map(vectors.map((v) => [v.productId, v]));
      const items: ShadowItemRecord[] = [];
      v2Order.slice(0, SHADOW_LOG_TOP_N).forEach((id, i) => {
        const vec = byId.get(id);
        if (vec === undefined) return;
        items.push({
          productId: id,
          v1Rank: v1Rank.get(id) ?? o.servedOrder.length + 1,
          v2Rank: i + 1,
          v2ScoreMilli: BigInt(Math.round((scores.get(id) ?? 0) * 1000)),
          features: vec.values,
        });
      });
      await this.store.record(
        {
          id: this.ids.uuidV7(),
          module: o.module,
          servedModelVersion: o.servedModelVersion.slice(0, 40),
          shadowModelVersion: this.ranker.modelVersion.slice(0, 40),
          personalized: o.personalized,
          botFiltered: isBotRequest(o.botScorePermille),
          candidateCount: Math.min(1000, o.candidates.length),
          k: cmp.k,
          overlapPermille: cmp.overlapPermille,
          top1Same: cmp.top1Same,
          meanRankShiftMilli: Math.round(cmp.meanRankShift * 1000),
          createdAtMs: this.clock.nowMs(),
        },
        items,
      );
    } catch {
      /* shadow is best effort by design */
    }
  }
}

export class GetShadowSummary {
  constructor(private readonly store: ShadowLogStore, private readonly clock: Clock) {}
  execute(windowHours: number): Promise<ShadowSummary> {
    return this.store.summary(this.clock.nowMs() - windowHours * 3_600_000);
  }
}

export class PurgeShadowLogs {
  constructor(private readonly store: ShadowLogStore, private readonly clock: Clock) {}
  execute(): Promise<number> {
    return this.store.purgeBefore(this.clock.nowMs() - SHADOW_RETENTION_DAYS * 86_400_000);
  }
}

export type RunEvaluationResult =
  | { readonly kind: "ok"; readonly run: EvalRunRecord; readonly replayed: boolean }
  | { readonly kind: "unknown_model"; readonly name: string };

export class RunEvaluation {
  constructor(
    private readonly models: ModelRegistryPort,
    private readonly store: EvalRunStore,
    private readonly clock: Clock,
    private readonly ids: IdPort,
  ) {}

  async execute(i: {
    requestKey: string;
    candidate: string;
    baseline: string;
    seed: number;
    requests: number;
    k: number;
  }): Promise<RunEvaluationResult> {
    const cand = this.models.get(i.candidate);
    if (cand === null) return { kind: "unknown_model", name: i.candidate };
    const base = this.models.get(i.baseline);
    if (base === null) return { kind: "unknown_model", name: i.baseline };
    const requests = Math.min(MAX_EVAL_REQUESTS, Math.max(1, i.requests));
    const logs = generateSyntheticLogs({ seed: seededRng(i.seed), requests });
    const cm = evaluateRanker(cand, logs, i.k);
    const bm = evaluateRanker(base, logs, i.k);
    const gate = checkRegression(cm, bm, DEFAULT_REGRESSION_GATE);
    const rec: EvalRunRecord = {
      id: this.ids.uuidV7(),
      requestKey: i.requestKey,
      candidateVersion: cand.modelVersion.slice(0, 40),
      baselineVersion: base.modelVersion.slice(0, 40),
      dataset: "synthetic",
      seed: i.seed,
      requests: cm.requests,
      k: i.k,
      candidateNdcgBps: bps(cm.ndcgAtK),
      candidateMapBps: bps(cm.map),
      baselineNdcgBps: bps(bm.ndcgAtK),
      baselineMapBps: bps(bm.map),
      passed: gate.passed,
      reasons: gate.reasons,
      createdAtMs: this.clock.nowMs(),
    };
    const r = await this.store.insert(rec);
    return { kind: "ok", run: r.run, replayed: !r.created };
  }
}

export class ListEvaluations {
  constructor(private readonly store: EvalRunStore) {}
  execute(limit: number): Promise<readonly EvalRunRecord[]> {
    return this.store.list(limit);
  }
}

export class EvaluateGuardrails {
  constructor(private readonly defaults: GuardrailConfig = DEFAULT_GUARDRAIL_CONFIG) {}
  execute(i: { control: ArmOutcome; treatment: ArmOutcome; config?: GuardrailConfig }): { config: GuardrailConfig; result: GuardrailResult } {
    const config = i.config ?? this.defaults;
    return { config, result: evaluateGuardrails(config, i.control, i.treatment) };
  }
}

export { BOT_SCORE_THRESHOLD_PERMILLE };
