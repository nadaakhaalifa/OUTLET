import { budgetBand, type OutfitRecord, type StylistCandidate, type StylistEvent } from "../../stylist";
import { planGap, type Feasibility, type GapOutfit, type MissingSlot } from "../domain/bridge";
import type { CalendarEvent } from "../domain/ports";
import {
  DAY_MS,
  FLAG_GAP_FILL,
  FLAG_STYLIST_ML,
  feasibilityFor,
  flagOn,
  isArchived,
  startOfUtcDay,
  viewOf,
  withTimeout,
  type CalendarDeps,
  type EventView,
} from "./shared";

export interface GeneratedOutfit {
  readonly record: OutfitRecord;
  readonly gap: GapOutfit;
  readonly feasibility: Feasibility;
}

export interface GenerateOutfitsView {
  readonly event: EventView;
  readonly outfits: readonly GeneratedOutfit[];
  /** The shopper already owns a whole outfit: nothing to buy. */
  readonly ownedOnly: boolean;
  /** When nothing fits: the slots that cannot be filled and what to add. */
  readonly shortfall: readonly MissingSlot[];
  readonly source: "ml" | "rules";
  readonly fallbackReason: "none" | "ml_off" | "ml_down";
  readonly remainingToday: number;
}

export type GenerateOutfitsOutcome =
  | { readonly kind: "ok"; readonly view: GenerateOutfitsView }
  | { readonly kind: "not_found" }
  | { readonly kind: "event_past" }
  | { readonly kind: "disabled" }
  | { readonly kind: "quota_exceeded"; readonly retryAfterMs: number }
  | { readonly kind: "catalog_unavailable" };

const OCCASION: Readonly<Record<CalendarEvent["kind"], string>> = {
  work: "work",
  wedding_guest: "wedding_guest",
  date: "date",
  eid: "eid",
  university: "university",
  travel: "casual",
  custom: "casual",
};

/**
 * POST /v1/me/calendar/events/{id}/outfits. Fills only the slots the shopper does not own, with the
 * stylist's optimizer or its rules fallback, within the event budget. Outfits are stored through the
 * stylist's store, so they share its fair-use counter and its add-to-bag bookkeeping.
 */
export class GenerateEventOutfits {
  constructor(private readonly d: CalendarDeps) {}

  async execute(input: {
    readonly userId: string;
    readonly eventId: string;
    readonly useRemainingBudget: boolean;
  }): Promise<GenerateOutfitsOutcome> {
    const d = this.d;
    const s = d.stylist;
    const now = d.clock.nowMs();
    const event = await d.store.getEvent(input.eventId);
    if (event === null || event.userId !== input.userId) return { kind: "not_found" };
    if (isArchived(event, now)) return { kind: "event_past" };
    if (!(await flagOn(d.flags, FLAG_GAP_FILL))) return { kind: "disabled" };

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

    // Budget: the event's typed budget wins; the budget suite is read only on request and only with consent.
    let budget: bigint | null = event.budgetPiastres;
    let budgetSource: "none" | "user" | "budget_suite" = budget === null ? "none" : "user";
    if (budget === null && input.useRemainingBudget) {
      const r = await s.budget.remainingBudgetPiastres(input.userId);
      if (r !== null) {
        budget = r < 0n ? 0n : r;
        budgetSource = "budget_suite";
      }
    }

    const mlAllowed = await flagOn(s.flags, FLAG_STYLIST_ML);
    let fallbackReason: GenerateOutfitsView["fallbackReason"] = mlAllowed ? "none" : "ml_off";
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
    // Personalization off: the style vector is never read.
    const personal = useMl && (await s.personalization.enabled(input.userId));
    const styleVector = personal ? await s.outfits.getStyleVector(input.userId) : null;

    const plan = planGap({
      candidates: working,
      ownedSlots: event.ownedSlots,
      budgetPiastres: budget,
      kind: event.kind,
      season: event.seasonBand,
      modest: event.modesty === "modest",
      useMl,
      styleVector,
      freeDeliveryThresholdPiastres: d.cfg.freeDeliveryThresholdPiastres,
      now: () => now,
    });
    if (plan.kind === "invalid_owned_slots") return { kind: "not_found" };

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
      totalPiastres: o.totalPiastres,
      // Only a budget the shopper typed is stored; a derived budget is never persisted.
      budgetPiastres: budgetSource === "user" ? budget : null,
      request: { occasion: OCCASION[event.kind], season: event.seasonBand, modest: event.modesty === "modest", world: "everything", budgetSource },
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
    await d.store.replacePlannedLinks(
      event.id,
      input.userId,
      records.map((r) => ({ id: d.ids.uuidV7(), outfitId: r.id })),
      now,
      records.length === 0 ? [] : [{ type: "calendar.outfit_planned", eventId: event.id, userId: input.userId, count: records.length }],
    );

    const outfits: GeneratedOutfit[] = [];
    for (const [i, record] of records.entries()) {
      const gap = buyable[i];
      if (gap === undefined) continue;
      outfits.push({ record, gap, feasibility: await feasibilityFor(d, input.userId, event, record.items.map((x) => x.storeId)) });
    }
    const links = (await d.store.linksFor([event.id])).get(event.id) ?? [];
    return {
      kind: "ok",
      view: {
        event: viewOf(event, links, now),
        outfits,
        ownedOnly,
        shortfall,
        source: plan.source,
        fallbackReason: plan.source === "rules" && fallbackReason === "none" ? "ml_down" : fallbackReason,
        remainingToday: Math.max(0, d.cfg.dailyGenerations - used - (records.length > 0 ? 1 : 0)),
      },
    };
  }
}

