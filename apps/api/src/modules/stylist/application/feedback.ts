import { updateStyleVector, type FeedbackSignal } from "../domain/bridge";
import type { StylistDeps } from "./shared";
import { FLAG_ML } from "./shared";

export type FeedbackOutcome =
  | { readonly kind: "not_found" }
  | { readonly kind: "recorded"; readonly styleUpdated: boolean }
  | { readonly kind: "not_recorded"; readonly reason: "personalization_off" };

/** POST /v1/stylist/feedback: like / dislike / swap updates the style vector online (spec 11). */
export class SubmitFeedback {
  constructor(private readonly d: StylistDeps) {}

  async execute(input: {
    readonly userId: string;
    readonly outfitId: string;
    readonly itemId: string;
    readonly signal: FeedbackSignal;
  }): Promise<FeedbackOutcome> {
    const d = this.d;
    const outfit = await d.store.getOutfit(input.outfitId);
    if (outfit === null || outfit.userId !== input.userId) return { kind: "not_found" };
    if (!outfit.items.some((i) => i.itemId === input.itemId)) return { kind: "not_found" };
    // Lawful basis is consent: with personalization off nothing is stored or learned.
    if (!(await d.personalization.enabled(input.userId))) return { kind: "not_recorded", reason: "personalization_off" };

    const now = d.clock.nowMs();
    await d.store.upsertFeedback(
      { id: d.ids.uuidV7(), outfitId: outfit.id, userId: input.userId, itemId: input.itemId, signal: input.signal, atMs: now },
      [{ type: "stylist.feedback", outfitId: outfit.id, userId: input.userId, signal: input.signal }],
    );

    let styleUpdated = false;
    let mlOn: boolean;
    try {
      mlOn = await d.flags.isEnabled(FLAG_ML);
    } catch {
      mlOn = false;
    }
    if (mlOn) {
      try {
        const emb = await d.embeddings.embeddings([input.itemId]);
        const e = emb.get(input.itemId);
        if (e !== undefined) {
          const current = await d.store.getStyleVector(input.userId);
          await d.store.putStyleVector(input.userId, updateStyleVector(current, e, input.signal), now);
          styleUpdated = true;
        }
      } catch {
        // Embeddings down: the feedback is stored and applied on a later model run.
      }
    }
    return { kind: "recorded", styleUpdated };
  }
}

/** History clear / consent withdrawal (spec 13): erase outfits, feedback and the style vector. */
export class ClearStylistHistory {
  constructor(private readonly d: StylistDeps) {}
  async execute(userId: string): Promise<void> {
    await this.d.store.eraseForUser(userId);
  }
}
