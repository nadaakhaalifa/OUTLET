import type { Candidate, Outfit, OutfitRequest, Season } from "../domain/bridge";
import type {
  BudgetPort,
  CandidateSourcePort,
  Clock,
  EmbeddingPort,
  IdPort,
  LivePricePort,
  OutfitKind,
  OutfitRecord,
  PersonalizationPort,
  Scope,
  StylistFlagPort,
  StylistLlmPort,
  StylistStore,
} from "../domain/ports";
import { budgetBand } from "../domain/ports";

export const FLAG_ML = "kill.stylist_ml";
export const FLAG_LLM = "kill.stylist_llm";
/** Stylist chat as a whole (spec P3-07). Allowed when true, like every kill switch (ADR-0028). */
export const FLAG_CHAT = "kill.stylist_chat";

export interface StylistConfig {
  readonly dailyGenerations: number;
  readonly mlTimeoutMs: number;
  readonly freeDeliveryThresholdPiastres: bigint;
}

export const DEFAULT_STYLIST_CONFIG: StylistConfig = {
  dailyGenerations: 30,
  mlTimeoutMs: 800,
  freeDeliveryThresholdPiastres: 200_000n,
};

export interface StylistDeps {
  readonly store: StylistStore;
  readonly candidates: CandidateSourcePort;
  readonly embeddings: EmbeddingPort;
  readonly budget: BudgetPort;
  readonly personalization: PersonalizationPort;
  readonly live: LivePricePort;
  readonly flags: StylistFlagPort;
  readonly llm: StylistLlmPort;
  readonly clock: Clock;
  readonly ids: IdPort;
  readonly cfg: StylistConfig;
}

export const OCCASION_FORMALITY: Readonly<Record<string, number>> = {
  work: 2,
  wedding_guest: 4,
  date: 3,
  eid: 3,
  beach: 0,
  gym: 0,
  university: 1,
  casual: 1,
};

export const DAY_MS = 86_400_000;
/** Fair use window: the UTC day, so the counter resets predictably. */
export const startOfUtcDay = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

export async function flagOn(flags: StylistFlagPort, key: string): Promise<boolean> {
  try {
    return await flags.isEnabled(key);
  } catch {
    return false; // fail closed
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error("failed"));
      },
    );
  });
}

export function toRecord(
  d: StylistDeps,
  userId: string,
  kind: OutfitKind,
  o: Outfit,
  generationId: string,
  ctx: { readonly request: OutfitRequest; readonly occasion: string | null; readonly world: Scope["world"]; readonly typedBudget: bigint | null; readonly budgetSource: "none" | "user" | "budget_suite" },
): OutfitRecord {
  return {
    id: d.ids.uuidV7(),
    generationId,
    userId,
    kind,
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
    budgetPiastres: ctx.typedBudget,
    request: { occasion: ctx.occasion, season: ctx.request.season, modest: ctx.request.modest, world: ctx.world, budgetSource: ctx.budgetSource },
    createdAtMs: d.clock.nowMs(),
    addedToBagAtMs: null,
  };
}

export const eventBand = budgetBand;
export type { Candidate, Season };
