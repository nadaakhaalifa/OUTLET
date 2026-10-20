import {
  DEFAULT_OPTIMIZER_CONFIG,
  optimizeOutfits,
  planCapsule,
  rulesOutfits,
  unaryValue,
  type Candidate,
  type Outfit,
  type OutfitRequest,
  type OutfitSource,
  type Season,
} from "../domain/bridge";
import { CatalogUnavailableError, budgetBand, type OutfitKind, type OutfitRecord, type Scope, type StylistCandidate } from "../domain/ports";
import {
  DAY_MS,
  FLAG_LLM,
  FLAG_ML,
  OCCASION_FORMALITY,
  flagOn,
  startOfUtcDay,
  toRecord,
  withTimeout,
  type StylistDeps,
} from "./shared";

export interface GenerateInput {
  readonly userId: string;
  readonly occasion: string | null;
  readonly season: Season;
  readonly modest: boolean;
  readonly formality: number | null;
  readonly typedBudget: bigint | null;
  readonly useRemainingBudget: boolean;
  readonly scope: Scope;
  readonly wishlistOnly: boolean;
  /** Free text. Scrubbed and sent to the LLM only through the gateway; never stored. */
  readonly note: string | null;
}

export interface GenerateView {
  readonly outfits: readonly OutfitRecord[];
  readonly source: OutfitSource;
  readonly fallbackReason: "none" | "ml_off" | "ml_down" | "no_embeddings" | "no_ml_result";
  readonly remainingToday: number;
  readonly latencyMs: number;
  readonly explanation: "none" | "no_items_in_size";
}

export type GenerateOutcome =
  | { readonly kind: "ok"; readonly view: GenerateView }
  | { readonly kind: "quota_exceeded"; readonly retryAfterMs: number }
  | { readonly kind: "catalog_unavailable" }
  | { readonly kind: "anchor_unavailable" };

interface Prepared {
  readonly request: OutfitRequest;
  readonly candidates: readonly StylistCandidate[];
  readonly occasion: string | null;
  readonly budgetSource: "none" | "user" | "budget_suite";
  readonly fallbackReason: GenerateView["fallbackReason"];
  readonly mlOk: boolean;
}

/** Shared pipeline for outfits, complete-the-look, wishlist and capsule: steps 1 to 3 of spec 11. */
async function prepare(
  d: StylistDeps,
  input: GenerateInput,
  anchorItemId: string | null,
): Promise<Prepared | "catalog_unavailable" | "anchor_unavailable"> {
  let candidates: readonly StylistCandidate[];
  try {
    candidates = await d.candidates.candidates({
      userId: input.userId,
      scope: input.scope,
      wishlistOnly: input.wishlistOnly,
      anchorItemId,
    });
  } catch (e) {
    if (e instanceof CatalogUnavailableError) return "catalog_unavailable";
    throw e;
  }

  // Budget: typed amount wins; else the remaining budget, only when the shopper opted in.
  let budget: bigint | null = input.typedBudget;
  let budgetSource: Prepared["budgetSource"] = budget === null ? "none" : "user";
  if (budget === null && input.useRemainingBudget) {
    const r = await d.budget.remainingBudgetPiastres(input.userId);
    if (r !== null) {
      budget = r < 0n ? 0n : r;
      budgetSource = "budget_suite";
    }
  }

  const mlAllowed = await flagOn(d.flags, FLAG_ML);
  const llmAllowed = mlAllowed && (await flagOn(d.flags, FLAG_LLM));
  let occasion = input.occasion;
  let season = input.season;
  let modest = input.modest;
  let formality = input.formality;

  if (llmAllowed && input.note !== null && input.note.trim().length > 0) {
    const intent = await d.llm.parseIntent({ userId: input.userId, note: input.note });
    // Explicit request fields win over inferred ones.
    if (intent !== null) {
      occasion = occasion ?? intent.occasion;
      formality = formality ?? intent.formality;
      if (season === "all") season = intent.season;
      modest = modest || intent.modest;
    }
  }

  // Personalization off: the style vector is never read (acceptance).
  const personal = mlAllowed && (await d.personalization.enabled(input.userId));
  const styleVector = personal ? await d.store.getStyleVector(input.userId) : null;

  let working: StylistCandidate[] = [...candidates];
  let fallbackReason: Prepared["fallbackReason"] = mlAllowed ? "none" : "ml_off";
  let mlOk = mlAllowed;
  if (mlAllowed && working.length > 0) {
    try {
      const emb = await withTimeout(d.embeddings.embeddings(working.map((c) => c.itemId)), d.cfg.mlTimeoutMs);
      working = working.map((c) => {
        const e = emb.get(c.itemId);
        return e === undefined ? c : { ...c, embedding: e };
      });
      if (emb.size === 0) fallbackReason = "no_embeddings";
    } catch {
      mlOk = false;
      fallbackReason = "ml_down";
    }
  }

  let locked: Candidate[] = [];
  if (anchorItemId !== null) {
    const a = working.find((c) => c.itemId === anchorItemId && c.inSize);
    if (a === undefined) return "anchor_unavailable";
    locked = [a];
  }

  const request: OutfitRequest = {
    budgetPiastres: budget,
    occasionFormality: formality ?? OCCASION_FORMALITY[occasion ?? "casual"] ?? 1,
    season,
    modest,
    scopedToSingleStore: input.scope.world === "my_stores" && input.scope.storeIds.length === 1,
    freeDeliveryThresholdPiastres: d.cfg.freeDeliveryThresholdPiastres,
    styleVector,
    locked,
  };

  // LLM rerank is a mild popularity boost on ids the gateway validated against this candidate set.
  if (mlOk && llmAllowed) {
    const top = [...working]
      .filter((c) => c.inSize)
      .sort((a, b) => unaryValue(b, request) - unaryValue(a, request) || (a.itemId < b.itemId ? -1 : 1))
      .slice(0, 20);
    const ids = new Set(top.map((c) => c.itemId));
    const ranked = await d.llm.rerank({
      userId: input.userId,
      occasion: occasion ?? "casual",
      season,
      items: top.map((c) => ({ id: c.itemId, title: c.title ?? "" })),
    });
    if (ranked !== null) {
      const boost = new Map<string, number>();
      ranked
        .filter((id) => ids.has(id))
        .slice(0, 10)
        .forEach((id, i) => boost.set(id, 300 - i * 30));
      working = working.map((c) => {
        const b = boost.get(c.itemId);
        return b === undefined ? c : { ...c, popularity: Math.min(1000, c.popularity + b) };
      });
    }
  }

  return { request, candidates: working, occasion, budgetSource, fallbackReason, mlOk };
}

async function quota(d: StylistDeps, userId: string): Promise<{ readonly used: number; readonly retryAfterMs: number }> {
  const since = startOfUtcDay(d.clock.nowMs());
  const used = await d.store.countSince(userId, since);
  return { used, retryAfterMs: since + DAY_MS - d.clock.nowMs() };
}

function generateOutfits(prep: Prepared, d: StylistDeps): { outfits: Outfit[]; source: OutfitSource } {
  if (prep.mlOk) {
    const r = optimizeOutfits({ candidates: prep.candidates, request: prep.request, now: () => d.clock.nowMs() });
    if (r.outfits.length > 0 && r.outfits.some((o) => o.complete)) return { outfits: [...r.outfits], source: "ml" };
    // No complete outfit: prefer the rules fallback only when it can do better than the optimizer's partial.
    const rules = rulesOutfits({ candidates: prep.candidates, request: prep.request });
    if (rules.outfits.some((o) => o.complete)) return { outfits: [...rules.outfits], source: "rules" };
    return { outfits: [...r.outfits], source: "ml" };
  }
  const rules = rulesOutfits({ candidates: prep.candidates, request: prep.request });
  return { outfits: [...rules.outfits], source: "rules" };
}

/** POST /v1/stylist/outfits (also "shop my wishlist" with wishlistOnly). */
export class GenerateOutfits {
  constructor(private readonly d: StylistDeps) {}

  async execute(input: GenerateInput): Promise<GenerateOutcome> {
    const d = this.d;
    const q = await quota(d, input.userId);
    if (q.used >= d.cfg.dailyGenerations) return { kind: "quota_exceeded", retryAfterMs: q.retryAfterMs };
    const started = d.clock.nowMs();
    const prep = await prepare(d, input, null);
    if (prep === "catalog_unavailable") return { kind: "catalog_unavailable" };
    if (prep === "anchor_unavailable") return { kind: "anchor_unavailable" };
    const gen = generateOutfits(prep, d);
    const kind: OutfitKind = input.wishlistOnly ? "wishlist" : "outfit";
    return finish(d, input, prep, gen.outfits, gen.source, kind, started, q.used);
  }
}

export interface CompleteLookInput extends GenerateInput {
  readonly anchorItemId: string;
}

/** POST /v1/stylist/complete-look. The anchor item is locked; the rest is optimized around it. */
export class CompleteLook {
  constructor(private readonly d: StylistDeps) {}

  async execute(input: CompleteLookInput): Promise<GenerateOutcome> {
    const d = this.d;
    const q = await quota(d, input.userId);
    if (q.used >= d.cfg.dailyGenerations) return { kind: "quota_exceeded", retryAfterMs: q.retryAfterMs };
    const started = d.clock.nowMs();
    const prep = await prepare(d, input, input.anchorItemId);
    if (prep === "catalog_unavailable") return { kind: "catalog_unavailable" };
    if (prep === "anchor_unavailable") return { kind: "anchor_unavailable" };
    const gen = generateOutfits(prep, d);
    return finish(d, input, prep, gen.outfits, gen.source, "complete_look", started, q.used);
  }
}

export interface CapsuleInput extends GenerateInput {
  readonly pieces: number;
  readonly outfitTarget: number;
}

/** POST /v1/stylist/capsule: "10 pieces, 20 outfits, under 5,000 EGP". Greedy coverage planner. */
export class PlanCapsule {
  constructor(private readonly d: StylistDeps) {}

  async execute(input: CapsuleInput): Promise<GenerateOutcome & { readonly outfitCount?: number }> {
    const d = this.d;
    const q = await quota(d, input.userId);
    if (q.used >= d.cfg.dailyGenerations) return { kind: "quota_exceeded", retryAfterMs: q.retryAfterMs };
    const started = d.clock.nowMs();
    const prep = await prepare(d, input, null);
    if (prep === "catalog_unavailable") return { kind: "catalog_unavailable" };
    if (prep === "anchor_unavailable") return { kind: "anchor_unavailable" };
    const plan = planCapsule({ candidates: prep.candidates, request: prep.request, pieces: input.pieces, maxOutfits: input.outfitTarget });
    const outfit: Outfit = {
      items: plan.items,
      totalPiastres: plan.totalPiastres,
      score: plan.outfitCount,
      complete: plan.items.length > 0,
      missing: [],
      source: prep.mlOk ? "ml" : "rules",
      freeDeliveryStoreIds: [],
    };
    const done = await finish(d, input, prep, plan.items.length === 0 ? [] : [outfit], outfit.source, "capsule", started, q.used);
    return done.kind === "ok" ? { ...done, outfitCount: plan.outfitCount } : done;
  }
}

async function finish(
  d: StylistDeps,
  input: GenerateInput,
  prep: Prepared,
  outfits: readonly Outfit[],
  source: OutfitSource,
  kind: OutfitKind,
  started: number,
  usedToday: number,
): Promise<GenerateOutcome> {
  const typedBudget = prep.budgetSource === "user" ? prep.request.budgetPiastres : null;
  const generationId = d.ids.uuidV7();
  const records = outfits.map((o) =>
    toRecord(d, input.userId, kind, o, generationId, {
      request: prep.request,
      occasion: prep.occasion,
      world: input.scope.world,
      typedBudget,
      budgetSource: prep.budgetSource,
    }),
  );
  const latencyMs = Math.max(0, d.clock.nowMs() - started);
  if (records.length > 0) {
    await d.store.insertOutfits(records, [
      {
        type: "outfit.generated",
        userId: input.userId,
        outfitIds: records.map((r) => r.id),
        count: records.length,
        budgetBand: budgetBand(prep.request.budgetPiastres),
        latencyMs,
        source,
      },
    ]);
  }
  const anyCandidateInSize = prep.candidates.some((c) => c.inSize);
  return {
    kind: "ok",
    view: {
      outfits: records,
      source,
      fallbackReason: source === "rules" && prep.fallbackReason === "none" ? "no_ml_result" : prep.fallbackReason,
      remainingToday: Math.max(0, d.cfg.dailyGenerations - usedToday - (records.length > 0 ? 1 : 0)),
      latencyMs,
      explanation: records.length === 0 && !anyCandidateInSize ? "no_items_in_size" : "none",
    },
  };
}

export { DEFAULT_OPTIMIZER_CONFIG };
