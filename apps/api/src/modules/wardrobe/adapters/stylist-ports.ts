import type { ModuleRef } from "@nestjs/core";
import type { BudgetPort, CandidateSourcePort, EmbeddingPort, PersonalizationPort, StylistFlagPort, StylistStore } from "../../stylist";
import {
  STYLIST_BUDGET,
  STYLIST_CANDIDATES,
  STYLIST_EMBEDDINGS,
  STYLIST_FLAGS,
  STYLIST_PERSONALIZATION,
  STYLIST_STORE,
} from "../../stylist";
import type { StylistPorts } from "../application/shared";

/**
 * The stylist module's own provider instances, looked up at call time: one catalog read model, one
 * outfit store (so the fair-use counter is shared) and one set of flags, with no second wiring.
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
  get flags(): StylistFlagPort {
    return this.get(STYLIST_FLAGS);
  }
  get outfits(): Pick<StylistStore, "insertOutfits" | "countSince" | "getStyleVector"> {
    return this.get<StylistStore>(STYLIST_STORE);
  }
}
