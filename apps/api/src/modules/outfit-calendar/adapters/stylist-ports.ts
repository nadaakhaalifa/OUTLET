import type { ModuleRef } from "@nestjs/core";
import type {
  BagPort,
  BudgetPort,
  CandidateSourcePort,
  EmbeddingPort,
  LivePricePort,
  PersonalizationPort,
  StylistFlagPort,
  StylistStore,
} from "../../stylist";
import {
  STYLIST_BAG,
  STYLIST_BUDGET,
  STYLIST_CANDIDATES,
  STYLIST_EMBEDDINGS,
  STYLIST_FLAGS,
  STYLIST_LIVE_PRICES,
  STYLIST_PERSONALIZATION,
  STYLIST_STORE,
} from "../../stylist";
import type { StylistPorts } from "../application/shared";

/**
 * The stylist module's own provider instances, looked up at call time. Calendar and stylist then
 * share one catalog read model, one price and stock re-validation, one bag writer, one set of
 * flags and one outfit store (so the fair-use counter is shared), with no second wiring to keep in
 * step in production composition.
 */
export class LazyStylistPorts implements StylistPorts {
  constructor(private readonly ref: ModuleRef) {}

  private get<T>(token: symbol): T {
    return this.ref.get<T>(token, { strict: false });
  }
  get candidates(): CandidateSourcePort {
    return this.get(STYLIST_CANDIDATES);
  }
  get embeddings(): EmbeddingPort {
    return this.get(STYLIST_EMBEDDINGS);
  }
  get budget(): BudgetPort {
    return this.get(STYLIST_BUDGET);
  }
  get personalization(): PersonalizationPort {
    return this.get(STYLIST_PERSONALIZATION);
  }
  get live(): LivePricePort {
    return this.get(STYLIST_LIVE_PRICES);
  }
  get bag(): BagPort {
    return this.get(STYLIST_BAG);
  }
  get flags(): StylistFlagPort {
    return this.get(STYLIST_FLAGS);
  }
  get outfits(): Pick<StylistStore, "insertOutfits" | "getOutfit" | "countSince" | "markAddedToBag" | "getStyleVector"> {
    return this.get<StylistStore>(STYLIST_STORE);
  }
}
