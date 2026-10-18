/** Single seam to the pure ranking domain (packages/domain/src/ranking). Aliases only. */
import { ranking as r, recommendations as rec } from "@outlet/domain";

export type Candidate = rec.Candidate;
export type UserFeatures = rec.UserFeatures;
export type RankerModel = r.RankerModel;
export type RankingFeatureVector = r.RankingFeatureVector;
export type EvalMetrics = r.EvalMetrics;
export type GuardrailConfig = r.GuardrailConfig;
export type GuardrailResult = r.GuardrailResult;
export type ArmOutcome = r.ArmOutcome;
export type RegressionGate = r.RegressionGate;
export type SessionEvent = r.SessionEvent;
export type TransitionModel = r.TransitionModel;
export type ShadowComparison = r.ShadowComparison;

export const RANKING_FEATURE_NAMES = r.RANKING_FEATURE_NAMES;
export const FEATURE_SCHEMA_VERSION = r.FEATURE_SCHEMA_VERSION;
export const BOT_SCORE_THRESHOLD_PERMILLE = r.BOT_SCORE_THRESHOLD_PERMILLE;
export const DEFAULT_GUARDRAIL_CONFIG = r.DEFAULT_GUARDRAIL_CONFIG;
export const DEFAULT_REGRESSION_GATE = r.DEFAULT_REGRESSION_GATE;
export const LinearRanker = r.LinearRanker;
export const FakeRanker = r.FakeRanker;
export const TreeEnsembleRanker = r.TreeEnsembleRanker;
export const buildFeatureVector = r.buildFeatureVector;
export const vectorViolations = r.vectorViolations;
export const compareShadow = r.compareShadow;
export const evaluateRanker = r.evaluateRanker;
export const generateSyntheticLogs = r.generateSyntheticLogs;
export const checkRegression = r.checkRegression;
export const evaluateGuardrails = r.evaluateGuardrails;
export const isBotRequest = r.isBotRequest;
export const scoreNextItems = r.scoreNextItems;
export const trainTransitions = r.trainTransitions;
export const seededRng = rec.seededRng;
export const forbiddenFeatureKeys = rec.forbiddenFeatureKeys;
