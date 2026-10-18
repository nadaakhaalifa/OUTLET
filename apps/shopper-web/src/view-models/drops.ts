import type { Locale } from "../i18n";
import { formatMoney } from "../lib/format";
import type { PublicDrop, PublicDropDetail } from "./types";

export type DropStateKey = "SCHEDULED" | "EARLY_ACCESS" | "LIVE" | "SOLD_OUT" | "ENDED" | "OTHER";

export function dropStateKey(state: string): DropStateKey {
  const s = state.toUpperCase();
  return s === "SCHEDULED" || s === "EARLY_ACCESS" || s === "LIVE" || s === "SOLD_OUT" || s === "ENDED" ? s : "OTHER";
}

/** Only drops that can still be joined or watched are indexable; ended and archived pages are noindex. */
export function isIndexableDrop(d: Pick<PublicDrop, "state">): boolean {
  const k = dropStateKey(d.state);
  return k === "SCHEDULED" || k === "EARLY_ACCESS" || k === "LIVE";
}

export function priceRange(d: PublicDropDetail): { min: bigint; max: bigint } | null {
  let min: bigint | null = null;
  let max: bigint | null = null;
  for (const it of d.items) {
    const v = BigInt(it.price);
    if (min === null || v < min) min = v;
    if (max === null || v > max) max = v;
  }
  return min === null || max === null ? null : { min, max };
}

export function mysteryText(d: PublicDropDetail, locale: Locale): { min: string; max: string; guaranteed: string } | null {
  if (d.mystery === null) return null;
  return {
    min: formatMoney(BigInt(d.mystery.min_value), locale),
    max: formatMoney(BigInt(d.mystery.max_value), locale),
    guaranteed: formatMoney(BigInt(d.mystery.guaranteed_min), locale),
  };
}

export interface LadderStep { readonly at: string; readonly min: bigint; readonly max: bigint }

export function ladderSteps(d: PublicDropDetail): LadderStep[] {
  return d.ladder
    .map((step) => {
      const vals = step.prices.map((p) => BigInt(p.price));
      const first = vals[0];
      if (first === undefined) return null;
      return { at: step.at, min: vals.reduce((a, b) => (b < a ? b : a), first), max: vals.reduce((a, b) => (b > a ? b : a), first) };
    })
    .filter((s): s is LadderStep => s !== null)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
