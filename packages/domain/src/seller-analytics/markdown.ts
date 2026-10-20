import { divideRoundHalfEven } from "../money";
import type { AgingSeverity } from "./stock";

export interface MarkdownInput {
  readonly currentPriceMinor: bigint;
  readonly severity: AgingSeverity;
  readonly sellThroughBps: number | null;
  /** Lowest price the seller allows; the suggestion is never below it. */
  readonly floorPriceMinor?: bigint;
}

/** Shown verbatim next to every suggestion (spec 19.1, price integrity 9). */
export const MARKDOWN_NOTICE = {
  en: "The new price will NOT show a % off badge unless it is verified against the Verified Reference Price.",
  ar: "لن يظهر السعر الجديد بشارة نسبة خصم ما لم يتم التحقق منه مقابل السعر المرجعي الموثّق.",
} as const;

export interface MarkdownRecommendation {
  readonly action: "markdown" | "hold";
  readonly suggestedPriceMinor: bigint | null;
  readonly stepBps: number;
  readonly basis: "heuristic_v1";
  /** Always false: a markdown never creates a % off claim by itself (spec 9, 17). */
  readonly showsPercentOff: false;
  readonly notice: typeof MARKDOWN_NOTICE;
}

const STEP_BPS: Readonly<Record<AgingSeverity, number>> = { watch: 1_000, aging: 2_000, critical: 3_000 };
const HEALTHY_SELL_THROUGH_BPS = 7_000;
const WHOLE_POUND = 100n;

/**
 * Deterministic v1 heuristic, NOT the elasticity model: it makes no clearance-probability claim.
 * Banker's rounding once, then rounded down to a whole pound so the price never ends in odd piastres.
 */
export function recommendMarkdown(input: MarkdownInput): MarkdownRecommendation {
  if (input.currentPriceMinor <= 0n) throw new RangeError("current price must be positive");
  const hold = (): MarkdownRecommendation => ({
    action: "hold",
    suggestedPriceMinor: null,
    stepBps: 0,
    basis: "heuristic_v1",
    showsPercentOff: false,
    notice: MARKDOWN_NOTICE,
  });
  if (input.sellThroughBps !== null && input.sellThroughBps >= HEALTHY_SELL_THROUGH_BPS) return hold();
  const step = STEP_BPS[input.severity];
  const raw = divideRoundHalfEven(input.currentPriceMinor * BigInt(10_000 - step), 10_000n);
  let price = (raw / WHOLE_POUND) * WHOLE_POUND;
  const floor = input.floorPriceMinor;
  if (floor !== undefined && price < floor) price = floor;
  if (price >= input.currentPriceMinor || price <= 0n) return hold();
  return {
    action: "markdown",
    suggestedPriceMinor: price,
    stepBps: step,
    basis: "heuristic_v1",
    showsPercentOff: false,
    notice: MARKDOWN_NOTICE,
  };
}
