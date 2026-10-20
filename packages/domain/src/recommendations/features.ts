import type { HistoryEvent } from "./types";

export const FEATURE_MAX_AGE_MS = 24 * 3_600_000;
export const HALF_LIFE_MS = 14 * 24 * 3_600_000;

/**
 * Derived per-user features. Deliberately closed: category and store affinity only (permille,
 * 0..1000). There is no budget, price ceiling, measurement, size profile or installment field and
 * none can be added without failing `forbiddenFeatureKeys` (spec 12 Privacy, spec 13).
 */
export interface UserFeatures {
  readonly categoryAffinity: Readonly<Record<string, number>>;
  readonly storeAffinity: Readonly<Record<string, number>>;
  readonly builtAtMs: number;
}

const FORBIDDEN = /budget|afford|installment|payday|measure|size_profile|waist|bust|hip|height|weight|income|salary|cap_mode/i;

/** Returns the offending key paths of an arbitrary feature object (empty means clean). */
export function forbiddenFeatureKeys(value: unknown, path = ""): string[] {
  if (value === null || typeof value !== "object") return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const p = path === "" ? k : `${path}.${k}`;
    if (FORBIDDEN.test(k)) out.push(p);
    out.push(...forbiddenFeatureKeys(v, p));
  }
  return out;
}

export function featuresAreFresh(f: Pick<UserFeatures, "builtAtMs">, nowMs: number): boolean {
  return nowMs - f.builtAtMs <= FEATURE_MAX_AGE_MS;
}

const WEIGHT: Readonly<Record<HistoryEvent["type"], number>> = {
  viewed: 1,
  searched: 0,
  saved: 3,
  bought: 6,
  returned: -4,
  outfit_generated: 0,
};

const decay = (ageMs: number): number => Math.pow(0.5, Math.max(0, ageMs) / HALF_LIFE_MS);

function normalize(raw: Map<string, number>): Record<string, number> {
  let max = 0;
  for (const v of raw.values()) max = Math.max(max, v);
  const out: Record<string, number> = {};
  if (max <= 0) return out;
  for (const [k, v] of [...raw.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const p = Math.round((Math.max(0, v) / max) * 1000);
    if (p > 0) out[k] = p;
  }
  return out;
}

/** Exponentially decayed, signed event weights normalised to permille. Pure and order independent. */
export function buildFeatures(events: readonly HistoryEvent[], nowMs: number): UserFeatures {
  const cat = new Map<string, number>();
  const store = new Map<string, number>();
  for (const e of events) {
    const w = WEIGHT[e.type] * decay(nowMs - e.atMs);
    if (w === 0) continue;
    if (e.categoryId !== null) cat.set(e.categoryId, (cat.get(e.categoryId) ?? 0) + w);
    if (e.storeId !== null) store.set(e.storeId, (store.get(e.storeId) ?? 0) + w);
  }
  return { categoryAffinity: normalize(cat), storeAffinity: normalize(store), builtAtMs: nowMs };
}

export type PersonalizationReason =
  | "requested_off"
  | "setting_off"
  | "no_consent"
  | "kill_switch"
  | "no_features"
  | "features_stale"
  | "on";

export interface PersonalizationInput {
  /** `personalized` query parameter; undefined means the client did not say. */
  readonly requested: boolean | undefined;
  readonly settingOn: boolean;
  readonly consentGranted: boolean;
  /** kill.ml_ranking evaluates true when ML ranking is allowed to run. */
  readonly mlRankingAllowed: boolean;
  readonly features: UserFeatures | null;
  readonly nowMs: number;
}

/** Fail closed: any doubt means non-personalized ranking (popularity + freshness only). */
export function personalizationDecision(i: PersonalizationInput): { personalized: boolean; reason: PersonalizationReason } {
  if (i.requested === false) return { personalized: false, reason: "requested_off" };
  if (!i.settingOn) return { personalized: false, reason: "setting_off" };
  if (!i.consentGranted) return { personalized: false, reason: "no_consent" };
  if (!i.mlRankingAllowed) return { personalized: false, reason: "kill_switch" };
  if (i.features === null) return { personalized: false, reason: "no_features" };
  if (!featuresAreFresh(i.features, i.nowMs)) return { personalized: false, reason: "features_stale" };
  return { personalized: true, reason: "on" };
}
