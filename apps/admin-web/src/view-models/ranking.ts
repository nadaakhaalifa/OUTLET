import type { GuardrailDecisionWire, RankingEvaluationWire, RankingShadowSummaryWire } from "../api/phase3-schemas";

/** Roles the API allows on /v1/admin/ranking/* (ranking.controller ROLES). Used to hide the link only. */
export const RANKING_ROLES = ["ops", "super_admin"] as const;

const pctFromPermille = (v: number | null): string | null => (v === null ? null : `${(v / 10).toFixed(1)}%`);
const pctFromBps = (v: number): string => `${(v / 100).toFixed(2)}%`;

export interface ShadowView {
  readonly windowHours: number;
  readonly runs: number;
  readonly personalizedRuns: number;
  readonly botFilteredRuns: number;
  /** null means "not measurable yet" (no runs), never zero. */
  readonly meanOverlap: string | null;
  readonly top1Same: string | null;
  readonly meanRankShift: string | null;
  readonly versions: readonly string[];
  readonly served: "v1";
}

export function shadowView(s: RankingShadowSummaryWire): ShadowView {
  return {
    windowHours: s.window_hours, runs: s.runs, personalizedRuns: s.personalized_runs, botFilteredRuns: s.bot_filtered_runs,
    meanOverlap: pctFromPermille(s.mean_overlap_permille), top1Same: pctFromPermille(s.top1_same_permille),
    meanRankShift: s.mean_rank_shift_milli === null ? null : (s.mean_rank_shift_milli / 1000).toFixed(2),
    versions: s.shadow_model_versions, served: s.served,
  };
}

export interface EvaluationRow {
  readonly id: string;
  readonly requestKey: string;
  readonly candidate: string;
  readonly baseline: string;
  readonly dataset: "synthetic" | "shadow_logs";
  readonly requests: number;
  readonly k: number;
  readonly candidateNdcg: string;
  readonly baselineNdcg: string;
  readonly candidateMap: string;
  readonly baselineMap: string;
  /** candidate minus baseline nDCG in basis points, signed. */
  readonly ndcgDeltaBps: number;
  readonly passed: boolean;
  readonly reasons: readonly string[];
  readonly createdAt: string;
}

export function evaluationRows(items: readonly RankingEvaluationWire[]): readonly EvaluationRow[] {
  return items.map((e) => ({
    id: e.id, requestKey: e.request_key, candidate: e.candidate_version, baseline: e.baseline_version, dataset: e.dataset,
    requests: e.requests, k: e.k, candidateNdcg: pctFromBps(e.candidate.ndcg_bps), baselineNdcg: pctFromBps(e.baseline.ndcg_bps),
    candidateMap: pctFromBps(e.candidate.map_bps), baselineMap: pctFromBps(e.baseline.map_bps),
    ndcgDeltaBps: e.candidate.ndcg_bps - e.baseline.ndcg_bps, passed: e.passed, reasons: e.reasons, createdAt: e.created_at,
  }));
}

export type RunFormError = "request_key" | "candidate" | "baseline" | "seed" | "requests" | "k";
export interface RunForm { readonly requestKey: string; readonly candidate: string; readonly baseline: string; readonly seed: string; readonly requests: string; readonly k: string }
export type RunFormResult =
  | { readonly ok: true; readonly value: { request_key: string; candidate: string; baseline: string; seed?: number; requests?: number; k?: number } }
  | { readonly ok: false; readonly errors: readonly RunFormError[] };

const intIn = (t: string, lo: number, hi: number): number | null | "empty" => {
  const s = t.trim();
  if (s === "") return "empty";
  if (!/^\d{1,10}$/.test(s)) return null;
  const n = Number(s);
  return n >= lo && n <= hi ? n : null;
};

export function validateRunForm(f: RunForm): RunFormResult {
  const errors: RunFormError[] = [];
  const key = f.requestKey.trim();
  if (!/^[A-Za-z0-9_.:-]{8,80}$/.test(key)) errors.push("request_key");
  const cand = f.candidate.trim(), base = f.baseline.trim();
  if (cand.length < 1 || cand.length > 40) errors.push("candidate");
  if (base.length < 1 || base.length > 40) errors.push("baseline");
  const seed = intIn(f.seed, 0, 2147483647), reqs = intIn(f.requests, 1, 2000), k = intIn(f.k, 1, 50);
  if (seed === null) errors.push("seed");
  if (reqs === null) errors.push("requests");
  if (k === null) errors.push("k");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      request_key: key, candidate: cand, baseline: base,
      ...(typeof seed === "number" ? { seed } : {}), ...(typeof reqs === "number" ? { requests: reqs } : {}), ...(typeof k === "number" ? { k } : {}),
    },
  };
}

export type GuardrailFormError = "control" | "treatment" | "returned_gt_orders" | "config";
export interface ArmForm { readonly orders: string; readonly returned: string; readonly complaints: string }
export interface GuardrailForm { readonly control: ArmForm; readonly treatment: ArmForm; readonly minOrders: string; readonly maxReturnBps: string; readonly maxComplaintBps: string }
export type GuardrailFormResult =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly errors: readonly GuardrailFormError[] };

const nat = (t: string): number | null => (/^\d{1,9}$/.test(t.trim()) ? Number(t.trim()) : null);

export function validateGuardrailForm(f: GuardrailForm): GuardrailFormResult {
  const errors: GuardrailFormError[] = [];
  const arm = (a: ArmForm, name: "control" | "treatment") => {
    const orders = nat(a.orders), returned = nat(a.returned), complaints = nat(a.complaints);
    if (orders === null || returned === null || complaints === null) { errors.push(name); return null; }
    if (returned > orders || complaints > orders) { errors.push("returned_gt_orders"); return null; }
    return { orders, returned, complaints };
  };
  const control = arm(f.control, "control"), treatment = arm(f.treatment, "treatment");
  const cfgTexts = [f.minOrders, f.maxReturnBps, f.maxComplaintBps].map((t) => t.trim());
  const anyCfg = cfgTexts.some((t) => t !== "");
  let config: { minOrdersPerArm: number; maxReturnRateIncreaseBps: number; maxComplaintRateIncreaseBps: number } | undefined;
  if (anyCfg) {
    const mo = nat(cfgTexts[0] ?? ""), mr = nat(cfgTexts[1] ?? ""), mc = nat(cfgTexts[2] ?? "");
    if (mo === null || mo < 1 || mr === null || mr > 10000 || mc === null || mc > 10000) errors.push("config");
    else config = { minOrdersPerArm: mo, maxReturnRateIncreaseBps: mr, maxComplaintRateIncreaseBps: mc };
  }
  if (errors.length > 0 || control === null || treatment === null) return { ok: false, errors: [...new Set(errors)] };
  return { ok: true, body: { control, treatment, ...(config === undefined ? {} : { config }) } };
}

export interface GuardrailView {
  readonly decision: GuardrailDecisionWire["decision"];
  readonly breaches: readonly string[];
  readonly returnDeltaBps: number | null;
  readonly complaintDeltaBps: number | null;
  readonly config: GuardrailDecisionWire["config"];
}
export const guardrailView = (g: GuardrailDecisionWire): GuardrailView => ({
  decision: g.decision, breaches: g.breaches, returnDeltaBps: g.return_rate_delta_bps, complaintDeltaBps: g.complaint_rate_delta_bps, config: g.config,
});
