import { budgetBand, type OutfitRecord, type StylistCandidate, type StylistEvent } from "../../stylist";
import { selectOwned, type OwnedPick } from "../domain/attributes";
import { KIND_FORMALITY, planGap, type EventKind, type GapOutfit, type MissingSlot, type OutfitSource, type Season } from "../domain/bridge";
import { DAY_MS, FLAG_STYLIST_ML, flagOn, startOfUtcDay, withTimeout, type WardrobeDeps } from "./shared";
import { gate, type GateOutcome } from "./wardrobe";

const OCCASION: Readonly<Record<EventKind, string>> = {
  work: "work",
  wedding_guest: "wedding_guest",
  date: "date",
  eid: "eid",
  university: "university",
  travel: "casual",
  custom: "casual",
};

export interface OccasionInput {
  readonly userId: string;
  readonly kind: EventKind;
  readonly season: Season;
  readonly modest: boolean;
  /** Restrict to these wardrobe items (the shopper's selection). null: the whole wardrobe. */
  readonly itemIds: readonly string[] | null;
}

export interface OwnedSlotsView {
  readonly picks: readonly OwnedPick[];
  /** Items that exist in the wardrobe but cannot be used yet (attributes incomplete). */
  readonly incompleteCount: number;
}

/**
 * Which owned garments would be locked for an occasion. Read only: a suggestion the app can pass as
 * `owned_slots` when it creates a calendar event (the event's own list stays user declared).
 */
export class SuggestOwnedSlots {
  constructor(private readonly d: WardrobeDeps) {}
  async execute(input: OccasionInput): Promise<OwnedSlotsView> {
    const all = await this.d.store.all(input.userId);
    const ready = all.filter((i) => i.imageState !== "infected");
    const picks = selectOwned(
      ready.map((i) => ({ id: i.id, attributes: i.attributes, createdAtMs: i.createdAtMs })),
      { formality: KIND_FORMALITY[input.kind], season: input.season, modest: input.modest },
      input.itemIds === null ? undefined : new Set(input.itemIds),
    );
    const incompleteCount = ready.filter((i) => i.attributes.category === undefined).length;
    return { picks, incompleteCount };
  }
}

export interface CompleteInput extends OccasionInput {
  readonly typedBudgetPiastres: bigint | null;
  readonly useRemainingBudget: boolean;
}

export interface CompletedOutfit {
  readonly record: OutfitRecord;
  readonly gap: GapOutfit;
}

export interface CompleteView {
  readonly owned: readonly OwnedPick[];
  readonly outfits: readonly CompletedOutfit[];
  /** The wardrobe alone already makes a whole outfit: nothing to buy. */
  readonly ownedOnly: boolean;
  readonly shortfall: readonly MissingSlot[];
  readonly source: OutfitSource;
  readonly fallbackReason: "none" | "ml_off" | "ml_down";
  readonly remainingToday: number;
}

export type CompleteOutcome =
  | { readonly kind: "ok"; readonly view: CompleteView }
  | GateOutcome
  | { readonly kind: "quota_exceeded"; readonly retryAfterMs: number }
  | { readonly kind: "catalog_unavailable" }
  | { readonly kind: "nothing_owned" };

/**
 * "Complete from wardrobe". Owned garments become locked, zero price slots of the calendar's gap
 * planner (the stylist optimizer), so they are never part of the budget arithmetic or of an outfit's
 * total, and the optimizer buys only the remaining slots. Outfits are stored through the stylist's
 * store, so add-to-bag, fair use and feedback are the stylist's.
 */
export class CompleteFromWardrobe {
  constructor(
    private readonly d: WardrobeDeps,
    private readonly owned: SuggestOwnedSlots,
  ) {}

  async execute(input: CompleteInput): Promise<CompleteOutcome> {
    const d = this.d;
    const s = d.stylist;
    const blocked = await gate(d, input.userId);
    if (blocked !== null) return blocked;
    const now = d.clock.nowMs();

    const own = await this.owned.execute(input);
    if (own.picks.length === 0) return { kind: "nothing_owned" };

    const since = startOfUtcDay(now);
    const used = await s.outfits.countSince(input.userId, since);
    if (used >= d.cfg.dailyGenerations) return { kind: "quota_exceeded", retryAfterMs: since + DAY_MS - now };

    let candidates: readonly StylistCandidate[];
    try {
      candidates = await s.candidates.candidates({
        userId: input.userId,
        scope: { world: "everything", storeIds: [] },
        wishlistOnly: false,
        anchorItemId: null,
      });
    } catch {
      return { kind: "catalog_unavailable" };
    }

    let budget: bigint | null = input.typedBudgetPiastres;
    let budgetSource: "none" | "user" | "budget_suite" = budget === null ? "none" : "user";
    if (budget === null && input.useRemainingBudget) {
      const r = await s.budget.remainingBudgetPiastres(input.userId);
      if (r !== null) {
        budget = r < 0n ? 0n : r;
        budgetSource = "budget_suite";
      }
    }

    const mlAllowed = await flagOn(s.flags, FLAG_STYLIST_ML);
    let fallbackReason: CompleteView["fallbackReason"] = mlAllowed ? "none" : "ml_off";
    let useMl = mlAllowed;
    let working: readonly StylistCandidate[] = candidates;
    if (mlAllowed && candidates.length > 0) {
      try {
        const emb = await withTimeout(s.embeddings.embeddings(candidates.map((c) => c.itemId)), d.cfg.mlTimeoutMs);
        working = candidates.map((c) => {
          const e = emb.get(c.itemId);
          return e === undefined ? c : { ...c, embedding: e };
        });
      } catch {
        useMl = false;
        fallbackReason = "ml_down";
      }
    }
    const personal = useMl && (await s.personalization.enabled(input.userId));
    const styleVector = personal ? await s.outfits.getStyleVector(input.userId) : null;

    const plan = planGap({
      candidates: working,
      ownedSlots: own.picks.map((p) => p.slot),
      budgetPiastres: budget,
      kind: input.kind,
      season: input.season,
      modest: input.modest,
      useMl,
      styleVector,
      freeDeliveryThresholdPiastres: d.cfg.freeDeliveryThresholdPiastres,
      now: () => now,
    });
    if (plan.kind === "invalid_owned_slots") return { kind: "nothing_owned" };

    const buyable = plan.outfits.filter((o) => o.items.length > 0);
    const ownedOnly = plan.outfits.some((o) => o.ownedOnly);
    const shortfall = buyable.length === 0 && !ownedOnly ? (plan.outfits.find((o) => !o.complete)?.missing ?? []) : [];

    const generationId = d.ids.uuidV7();
    const records: OutfitRecord[] = buyable.map((o) => ({
      id: d.ids.uuidV7(),
      generationId,
      userId: input.userId,
      kind: "outfit",
      source: o.source,
      complete: o.complete,
      items: o.items.map((i) => ({
        itemId: i.itemId,
        storeId: i.storeId,
        slot: i.slot,
        pricePiastres: i.pricePiastres,
        verifiedDiscountPct: i.verifiedDiscountPct,
      })),
      missing: o.missing,
      score: o.score,
      // Buyable items only: owned garments are zero price slots and never enter a total.
      totalPiastres: o.totalPiastres,
      budgetPiastres: budgetSource === "user" ? budget : null,
      request: { occasion: OCCASION[input.kind], season: input.season, modest: input.modest, world: "everything", budgetSource },
      createdAtMs: now,
      addedToBagAtMs: null,
    }));
    if (records.length > 0) {
      const ev: StylistEvent = {
        type: "outfit.generated",
        userId: input.userId,
        outfitIds: records.map((r) => r.id),
        count: records.length,
        budgetBand: budgetBand(budget),
        latencyMs: Math.max(0, d.clock.nowMs() - now),
        source: plan.source,
      };
      await s.outfits.insertOutfits(records, [ev]);
    }
    return {
      kind: "ok",
      view: {
        owned: own.picks,
        outfits: records.flatMap((record, i) => {
          const gap = buyable[i];
          return gap === undefined ? [] : [{ record, gap }];
        }),
        ownedOnly,
        shortfall,
        source: plan.source,
        fallbackReason: plan.source === "rules" && fallbackReason === "none" ? "ml_down" : fallbackReason,
        remainingToday: Math.max(0, d.cfg.dailyGenerations - used - (records.length > 0 ? 1 : 0)),
      },
    };
  }
}
