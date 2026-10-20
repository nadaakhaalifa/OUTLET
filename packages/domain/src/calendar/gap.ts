import { optimizeOutfits } from "../stylist/optimizer";
import { rulesOutfits } from "../stylist/fallback";
import { SLOTS, TEMPLATES } from "../stylist/types";
import type { Candidate, MissingSlot, Outfit, OutfitRequest, OutfitSource, Season, Slot } from "../stylist/types";
import type { EventKind, OutfitStatus } from "./types";

/** Formality per event kind, 0 (loungewear) to 4 (black tie); matches the stylist occasion table. */
export const KIND_FORMALITY: Readonly<Record<EventKind, number>> = {
  work: 2,
  wedding_guest: 4,
  date: 3,
  eid: 3,
  university: 1,
  travel: 1,
  custom: 1,
};

const OWNED_PREFIX = "owned:";
export const isOwnedPlaceholder = (itemId: string): boolean => itemId.startsWith(OWNED_PREFIX);

/** True when some outfit template contains every owned slot (a dress excludes top and bottom). */
export function ownedSlotsConsistent(owned: readonly Slot[]): boolean {
  return TEMPLATES.some((t) => owned.every((s) => t.includes(s)));
}

/** True when the owned slots already make a whole outfit. */
export function ownedCoversTemplate(owned: readonly Slot[]): boolean {
  const have = new Set(owned);
  return TEMPLATES.some((t) => t.every((s) => have.has(s)));
}

/**
 * A slot the shopper already owns enters the optimizer as a locked, zero-price item. Each gets its
 * own pseudo store so the per-store cap never counts it, and a neutral profile so it pairs with
 * anything at the event's formality.
 */
export function ownedPlaceholder(slot: Slot, formality: number): Candidate {
  return {
    itemId: `${OWNED_PREFIX}${slot}`,
    storeId: `${OWNED_PREFIX}${slot}`,
    slot,
    pricePiastres: 0n,
    verifiedDiscountPct: 0,
    colors: [],
    formality,
    seasons: ["all"],
    coverage: { sleeve: "n/a", neckline: "n/a", length: "n/a" },
    popularity: 0,
    inSize: true,
  };
}

export interface GapInput {
  readonly candidates: readonly Candidate[];
  readonly ownedSlots: readonly Slot[];
  /** null: no budget constraint. */
  readonly budgetPiastres: bigint | null;
  readonly kind: EventKind;
  readonly season: Season;
  readonly modest: boolean;
  /** false: rules fallback only (ML or embeddings down, or kill switch). */
  readonly useMl: boolean;
  readonly styleVector: readonly number[] | null;
  readonly freeDeliveryThresholdPiastres: bigint;
  readonly now?: () => number;
}

export interface GapOutfit {
  /** Items to buy. Owned slots are not listed. */
  readonly items: readonly Candidate[];
  readonly ownedSlots: readonly Slot[];
  /** Sum of `items` only: what the shopper pays. */
  readonly totalPiastres: bigint;
  readonly complete: boolean;
  readonly missing: readonly MissingSlot[];
  readonly score: number;
  readonly source: OutfitSource;
  readonly ownedOnly: boolean;
  /** Budget left after this gap, null when there is no budget. Never negative. */
  readonly remainingBudgetPiastres: bigint | null;
}

export type GapPlan =
  | { readonly kind: "invalid_owned_slots" }
  | { readonly kind: "ok"; readonly outfits: readonly GapOutfit[]; readonly source: OutfitSource };

const uniq = (s: readonly Slot[]): Slot[] => SLOTS.filter((x) => s.includes(x));

/**
 * Fill the missing slots of an event with the existing stylist optimizer (beam search) or its rules
 * fallback. The budget constraint is the optimizer's hard constraint over the items to buy; this
 * function re-checks it and drops any outfit that would exceed the budget (defence in depth).
 */
export function planGap(input: GapInput): GapPlan {
  const owned = uniq(input.ownedSlots);
  if (!ownedSlotsConsistent(owned)) return { kind: "invalid_owned_slots" };
  if (ownedCoversTemplate(owned)) {
    const o: GapOutfit = {
      items: [],
      ownedSlots: owned,
      totalPiastres: 0n,
      complete: true,
      missing: [],
      score: 0,
      source: input.useMl ? "ml" : "rules",
      ownedOnly: true,
      remainingBudgetPiastres: input.budgetPiastres,
    };
    return { kind: "ok", outfits: [o], source: o.source };
  }
  const formality = KIND_FORMALITY[input.kind];
  const request: OutfitRequest = {
    budgetPiastres: input.budgetPiastres,
    occasionFormality: formality,
    season: input.season,
    modest: input.modest,
    scopedToSingleStore: false,
    freeDeliveryThresholdPiastres: input.freeDeliveryThresholdPiastres,
    styleVector: input.useMl ? input.styleVector : null,
    locked: owned.map((s) => ownedPlaceholder(s, formality)),
  };
  const real = input.candidates.filter((c) => !isOwnedPlaceholder(c.itemId));
  let source: OutfitSource = input.useMl ? "ml" : "rules";
  let outfits: readonly Outfit[];
  if (input.useMl) {
    const r = optimizeOutfits({ candidates: real, request, ...(input.now === undefined ? {} : { now: input.now }) });
    outfits = r.outfits;
    if (!outfits.some((o) => o.complete)) {
      const rules = rulesOutfits({ candidates: real, request });
      if (rules.outfits.some((o) => o.complete)) {
        outfits = rules.outfits;
        source = "rules";
      }
    }
  } else {
    outfits = rulesOutfits({ candidates: real, request }).outfits;
  }
  const out: GapOutfit[] = [];
  for (const o of outfits) {
    const items = o.items.filter((i) => !isOwnedPlaceholder(i.itemId));
    const total = items.reduce((s, i) => s + i.pricePiastres, 0n);
    if (input.budgetPiastres !== null && total > input.budgetPiastres) continue;
    out.push({
      items,
      ownedSlots: owned,
      totalPiastres: total,
      complete: o.complete,
      missing: o.missing,
      score: o.score,
      source: o.source === "rules" ? "rules" : source,
      ownedOnly: false,
      remainingBudgetPiastres: input.budgetPiastres === null ? null : input.budgetPiastres - total,
    });
  }
  return { kind: "ok", outfits: out, source };
}

/** Outfit status shown on an event. Documented rule: owned covers a template, else linked outfits. */
export function outfitStatus(input: {
  readonly ownedSlots: readonly Slot[];
  readonly linkStatuses: readonly ("planned" | "in_bag" | "purchased" | "worn")[];
}): OutfitStatus {
  if (ownedCoversTemplate(input.ownedSlots)) return "owned_only";
  if (input.linkStatuses.length === 0) return "none";
  if (input.linkStatuses.some((s) => s === "purchased" || s === "worn")) return "planned";
  return "needs_purchases";
}

const NEXT: Readonly<Record<string, readonly string[]>> = {
  planned: ["in_bag"],
  in_bag: ["planned", "purchased"],
  purchased: ["worn"],
  worn: [],
};
export const canTransitionLink = (from: string, to: string): boolean => (NEXT[from] ?? []).includes(to);

/** Past events are archived once their start has passed. */
export const isPast = (startsAtMs: number, nowMs: number): boolean => startsAtMs <= nowMs;
