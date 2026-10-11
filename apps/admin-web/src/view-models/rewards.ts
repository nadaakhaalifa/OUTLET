import type { RewardsConfigWire } from "../api/schemas";

export const PPM = 1_000_000;
export type OutcomeKind = "nothing" | "coins" | "voucher";
export interface OddsOutcomeInput { readonly id: string; readonly kind: string; readonly percent: string; readonly coins: string; readonly voucher: string }
export interface OddsOutcome { id: string; kind: OutcomeKind; probability_ppm: number; coins: string | null; voucher_template_id: string | null }
export type OddsError = "empty" | "too_many" | "id" | "duplicate_id" | "kind" | "percent" | "coins" | "voucher" | "sum";
export type OddsResult =
  | { readonly ok: true; readonly outcomes: readonly OddsOutcome[]; readonly totalPpm: number }
  | { readonly ok: false; readonly errors: readonly OddsError[]; readonly totalPpm: number };

/** "12.5" to parts-per-million (1,000,000 = 100%), up to 4 decimals, no floats. */
export function percentToPpm(text: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,4}))?$/.exec(text.trim());
  if (m === null) return null;
  const v = Number(m[1]) * 10_000 + Number((m[2] ?? "").padEnd(4, "0") || "0");
  return v >= 0 && v <= PPM ? v : null;
}
export function ppmToPercent(ppm: number): string {
  const whole = Math.floor(ppm / 10_000);
  const frac = String(ppm % 10_000).padStart(4, "0").replace(/0+$/, "");
  return frac === "" ? String(whole) : `${whole}.${frac}`;
}

/**
 * Odds must be fully disclosed and sum to exactly 100% (1,000,000 ppm). The editor refuses anything else: there
 * is no "remainder is nothing" shortcut, a losing outcome has to be a listed row (spec 15.5: disclosed odds).
 */
export function validateOdds(rows: readonly OddsOutcomeInput[]): OddsResult {
  const errors = new Set<OddsError>();
  const out: OddsOutcome[] = [];
  let total = 0;
  if (rows.length === 0) errors.add("empty");
  if (rows.length > 20) errors.add("too_many");
  const ids = new Set<string>();
  for (const r of rows) {
    if (!/^[a-z0-9_-]{1,40}$/.test(r.id)) errors.add("id");
    if (ids.has(r.id)) errors.add("duplicate_id");
    ids.add(r.id);
    const kind = r.kind === "nothing" || r.kind === "coins" || r.kind === "voucher" ? r.kind : null;
    if (kind === null) errors.add("kind");
    const ppm = percentToPpm(r.percent);
    if (ppm === null) errors.add("percent");
    else total += ppm;
    const coins = /^[1-9]\d{0,17}$/.test(r.coins) ? r.coins : null;
    if (kind === "coins" && coins === null) errors.add("coins");
    if (kind === "voucher" && !/^[A-Za-z0-9_-]{1,80}$/.test(r.voucher)) errors.add("voucher");
    if (kind !== null && ppm !== null) {
      out.push({ id: r.id, kind, probability_ppm: ppm, coins: kind === "coins" ? coins : null, voucher_template_id: kind === "voucher" ? r.voucher : null });
    }
  }
  if (total !== PPM) errors.add("sum");
  return errors.size === 0 ? { ok: true, outcomes: out, totalPpm: total } : { ok: false, errors: [...errors], totalPpm: total };
}

export type RewardsFormError = "piastres" | "tiers" | "max_coins";
export interface RewardsForm { readonly piastresPerCoin: string; readonly silverFrom: string; readonly goldFrom: string; readonly blackFrom: string; readonly maxCoinsPerEvent: string }
export function validateRewardsEdit(f: RewardsForm): { readonly ok: boolean; readonly errors: readonly RewardsFormError[] } {
  const errors: RewardsFormError[] = [];
  const pos = (s: string): bigint | null => (/^[1-9]\d{0,17}$/.test(s) ? BigInt(s) : null);
  if (pos(f.piastresPerCoin) === null) errors.push("piastres");
  const s = pos(f.silverFrom), g = pos(f.goldFrom), b = pos(f.blackFrom);
  if (s === null || g === null || b === null || !(s < g && g < b)) errors.push("tiers");
  if (pos(f.maxCoinsPerEvent) === null) errors.push("max_coins");
  return { ok: errors.length === 0, errors };
}

/** Merge the edited fields onto the current config so PUT (a full replace) never drops a field. */
export function mergeRewards(current: RewardsConfigWire, f: RewardsForm, approvalId: string): Record<string, unknown> {
  const rest = Object.fromEntries(Object.entries(current).filter(([k]) => k !== "version"));
  return { ...rest, piastres_per_coin: f.piastresPerCoin, silver_from: f.silverFrom, gold_from: f.goldFrom, black_from: f.blackFrom, max_coins_per_event: f.maxCoinsPerEvent, approval_id: approvalId };
}
