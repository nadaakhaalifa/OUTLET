import { DAY_MS } from "./window.js";

export type ViolationRule = "fake_reference" | "pre_discount_inflation" | "parity_breach" | "parity_unfixed" | "channel_disconnected" | "ping_pong" | "duplicate_reset" | "image_reuse" | "sudden_discount";
export type LadderAction = "autocorrect_display" | "remove_badge" | "rank_penalty" | "demote" | "pause_sku" | "remove_all_pct" | "lose_verified" | "commission_surcharge" | "block_drops" | "suspend_store";
export interface Violation {
  readonly rule: ViolationRule;
  readonly at: Date;
  readonly severe?: boolean;
}
export interface LadderParams {
  readonly windowDays: number;
  readonly repeatThreshold: number;
  readonly sanctionThreshold: number;
}
/** repeatThreshold is a default pending counsel (V15) and the owner (V28); suspension always carries human review. */
export const DEFAULT_LADDER: LadderParams = { windowDays: 90, repeatThreshold: 6, sanctionThreshold: 3 };

export interface LadderAct {
  readonly action: LadderAction;
  readonly expiresAt: Date | null;
}
export interface LadderDecision {
  readonly acts: readonly LadderAct[];
  readonly violations90d: number;
  readonly humanReviewRequired: boolean;
  readonly reviewDueBy: Date | null;
}

/** Adds business days, treating Friday and Saturday as the Egyptian weekend (public holidays not modelled, V15). */
export const addBusinessDays = (from: Date, n: number): Date => {
  const d = new Date(from.getTime());
  let left = n;
  while (left > 0) {
    d.setTime(d.getTime() + DAY_MS);
    const wd = d.getUTCDay();
    if (wd !== 5 && wd !== 6) left--;
  }
  return d;
};

const perEvent = (v: Violation, now: Date): LadderAct[] => {
  const in30 = new Date(now.getTime() + 30 * DAY_MS);
  switch (v.rule) {
    case "fake_reference": return [{ action: "autocorrect_display", expiresAt: null }];
    case "pre_discount_inflation": return [{ action: "remove_badge", expiresAt: in30 }, { action: "rank_penalty", expiresAt: in30 }];
    case "parity_breach": return [{ action: "demote", expiresAt: null }];
    case "parity_unfixed": return [{ action: "demote", expiresAt: null }, { action: "pause_sku", expiresAt: null }];
    case "channel_disconnected": return [{ action: "remove_all_pct", expiresAt: null }];
    default: return [{ action: "rank_penalty", expiresAt: in30 }];
  }
};

/** Pure ladder: `current` is the violation being handled, `history` the store's earlier violations. Monotonic: more history never removes an act. */
export const enforcementLadder = (current: Violation, history: readonly Violation[], now: Date, p: LadderParams = DEFAULT_LADDER): LadderDecision => {
  const cutoff = now.getTime() - p.windowDays * DAY_MS;
  const recent = history.filter((h) => h.at.getTime() >= cutoff && h.at.getTime() <= now.getTime());
  const n = recent.length + 1;
  const in30 = new Date(now.getTime() + 30 * DAY_MS);
  const acts = [...perEvent(current, now)];
  if (n >= p.sanctionThreshold) acts.push({ action: "lose_verified", expiresAt: null }, { action: "commission_surcharge", expiresAt: null }, { action: "block_drops", expiresAt: in30 });
  const severe = current.severe === true || recent.some((h) => h.severe === true) || n >= p.repeatThreshold;
  if (severe) acts.push({ action: "suspend_store", expiresAt: null });
  const seen = new Set<LadderAction>();
  const uniq = acts.filter((a) => (seen.has(a.action) ? false : (seen.add(a.action), true)));
  return { acts: uniq, violations90d: n, humanReviewRequired: severe, reviewDueBy: severe ? addBusinessDays(now, 5) : null };
};
