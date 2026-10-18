import type {
  ArmOutcome,
  Candidate,
  GuardrailConfig,
  GuardrailResult,
  RankerModel,
  RankingFeatureVector,
  SessionEvent,
  UserFeatures,
} from "./bridge";

export interface Clock {
  nowMs(): number;
}
export interface IdPort {
  uuidV7(): string;
}

/** Async seam in front of a model service. The default adapter wraps a pure domain RankerModel. */
export interface RankerV2Port {
  readonly modelVersion: string;
  score(batch: readonly RankingFeatureVector[]): Promise<readonly number[]>;
}

/** Sequence model behind a port (GRU4Rec/SASRec class in production, deterministic fake here). */
export interface SessionNextItemPort {
  readonly modelVersion: string;
  /** Called only for personalized requests; absent session means no call at all. */
  nextItemScores(session: readonly SessionEvent[], candidateIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
}

export interface FlagPort {
  /** kill.ranking_v2_shadow: true means shadow scoring may run. */
  shadowAllowed(): Promise<boolean>;
}

/** Names of models the evaluation endpoint may compare. */
export interface ModelRegistryPort {
  names(): readonly string[];
  get(name: string): RankerModel | null;
}

export const SHADOW_MODULES = ["feed", "similar", "similar_for_less", "goes_with", "restock", "price_drop", "exploration"] as const;
export type ShadowModule = (typeof SHADOW_MODULES)[number];

export interface ShadowObservation {
  readonly module: ShadowModule;
  readonly servedModelVersion: string;
  /** Product ids in the order v1 served them. */
  readonly servedOrder: readonly string[];
  readonly candidates: readonly Candidate[];
  /** Must be null when the request was not personalized. */
  readonly user: UserFeatures | null;
  readonly personalized: boolean;
  readonly sizeLabels?: readonly string[] | null;
  readonly nowMs: number;
  readonly botScorePermille?: number;
}

/** What the serving path calls. Never throws, never changes what is served. */
export interface ShadowObserverPort {
  observe(o: ShadowObservation): Promise<void>;
}

export interface ShadowRunRecord {
  readonly id: string;
  readonly module: ShadowModule;
  readonly servedModelVersion: string;
  readonly shadowModelVersion: string;
  readonly personalized: boolean;
  readonly botFiltered: boolean;
  readonly candidateCount: number;
  readonly k: number;
  readonly overlapPermille: number;
  readonly top1Same: boolean;
  readonly meanRankShiftMilli: number;
  readonly createdAtMs: number;
}
export interface ShadowItemRecord {
  readonly productId: string;
  readonly v1Rank: number;
  readonly v2Rank: number;
  readonly v2ScoreMilli: bigint;
  readonly features: RankingFeatureVector["values"];
}
export interface ShadowSummary {
  readonly runs: number;
  readonly personalizedRuns: number;
  readonly botFilteredRuns: number;
  readonly meanOverlapPermille: number | null;
  readonly top1SamePermille: number | null;
  readonly meanRankShiftMilli: number | null;
  readonly shadowModelVersions: readonly string[];
}

export interface ShadowLogStore {
  record(run: ShadowRunRecord, items: readonly ShadowItemRecord[]): Promise<void>;
  summary(sinceMs: number): Promise<ShadowSummary>;
  itemsOf(runId: string): Promise<readonly ShadowItemRecord[]>;
  /** Retention job. Returns rows removed. */
  purgeBefore(beforeMs: number): Promise<number>;
}

export interface EvalRunRecord {
  readonly id: string;
  readonly requestKey: string;
  readonly candidateVersion: string;
  readonly baselineVersion: string;
  readonly dataset: "synthetic" | "shadow_logs";
  readonly seed: number | null;
  readonly requests: number;
  readonly k: number;
  readonly candidateNdcgBps: number;
  readonly candidateMapBps: number;
  readonly baselineNdcgBps: number;
  readonly baselineMapBps: number;
  readonly passed: boolean;
  readonly reasons: readonly string[];
  readonly createdAtMs: number;
}

export interface EvalRunStore {
  /** Idempotent by requestKey: returns the stored row and whether it was newly created. */
  insert(run: EvalRunRecord): Promise<{ readonly run: EvalRunRecord; readonly created: boolean }>;
  list(limit: number): Promise<readonly EvalRunRecord[]>;
}

export interface GuardrailInput {
  readonly config: GuardrailConfig;
  readonly control: ArmOutcome;
  readonly treatment: ArmOutcome;
}
export type { GuardrailResult };
