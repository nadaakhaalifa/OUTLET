export const RANKING_RANKER = Symbol("ranking.RankerV2Port");
export const RANKING_SESSION = Symbol("ranking.SessionNextItemPort");
export const RANKING_SHADOW_STORE = Symbol("ranking.ShadowLogStore");
export const RANKING_EVAL_STORE = Symbol("ranking.EvalRunStore");
export const RANKING_FLAGS = Symbol("ranking.FlagPort");
export const RANKING_MODELS = Symbol("ranking.ModelRegistryPort");
export const RANKING_ADMIN_RESOLVER = Symbol("ranking.AdminResolver");
/** Optional dependency of the recommendations serving path. */
export const RANKING_SHADOW_OBSERVER = Symbol("ranking.ShadowObserverPort");
export const RANKING_SHADOW_SUMMARY = Symbol("ranking.GetShadowSummary");
export const RANKING_PURGE = Symbol("ranking.PurgeShadowLogs");
export const RANKING_RUN_EVAL = Symbol("ranking.RunEvaluation");
export const RANKING_LIST_EVAL = Symbol("ranking.ListEvaluations");
export const RANKING_GUARDRAILS = Symbol("ranking.EvaluateGuardrails");
