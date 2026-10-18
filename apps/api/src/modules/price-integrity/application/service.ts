import { createHash } from "node:crypto";
import type { PriceBlockReader } from "../../catalog";
import {
  MS_PER_DAY,
  VIOLATION_LOOKBACK_MS,
  WINDOW_MS,
  computeVrp,
  decideEnforcement,
  detectPreDropInflation,
  normalizeEvents,
  priceTrustScore,
  toPriceBlock,
  toSnapshot,
  trustBand,
  type EnforcementAction,
  type PriceBlockInput,
  type PriceEvent,
  type PriceEventSource,
  type TrustBand,
  type ViolationKind,
  type VrpResult,
  type VrpSnapshot,
} from "../domain/domain";
import type {
  ClaimStore,
  EnforcementRecord,
  EnforcementStore,
  ExternalEvidencePort,
  NewPriceEvent,
  PriceEventStore,
  PriceIntegrityClock,
  SkuDirectory,
} from "../domain/ports";

export interface PriceIntegrityDeps {
  readonly events: PriceEventStore;
  readonly external: ExternalEvidencePort;
  readonly claims: ClaimStore;
  readonly enforcement: EnforcementStore;
  readonly directory: SkuDirectory;
  readonly clock: PriceIntegrityClock;
  readonly ids: { uuidV7(): string };
}

export interface RecordPriceChangeInput {
  readonly skuId: string;
  readonly storeId: string;
  readonly priceAmount: bigint;
  /** Defaults to now. Never in the past relative to the latest event. */
  readonly validFromMs?: number;
  readonly source: PriceEventSource;
  readonly actorId: string | null;
  readonly idempotencyKey: string;
}

export interface PriceChangeOutcome {
  readonly created: boolean;
  readonly event: PriceEvent;
  readonly result: VrpResult;
  readonly claimId: string;
  readonly actions: readonly EnforcementAction[];
}

export interface ClaimReview {
  readonly display: PriceBlockInput;
  readonly corrected: boolean;
  readonly actions: readonly EnforcementAction[];
}

export interface SkuEvidenceView {
  readonly skuId: string;
  readonly result: VrpResult;
  readonly claimId: string;
  readonly block: PriceBlockInput;
  readonly lowest30dAmount: bigint | null;
  readonly history: readonly { readonly priceAmount: bigint; readonly validFromMs: number }[];
}

export interface ProductEvidenceView {
  readonly productId: string;
  readonly computedAtMs: number;
  readonly skus: readonly SkuEvidenceView[];
}

export interface StoreTrustView {
  readonly storeId: string;
  readonly score: number;
  readonly band: TrustBand;
  readonly windowDays: number;
  readonly violations: number;
  readonly openCrossChannelFindings: number;
  readonly claimsEvaluated: number;
  readonly claimsVerified: number;
  readonly claimsAutoCorrected: number;
  readonly recent: readonly EnforcementRecord[];
}

/** Deterministic UUID-shaped id so a claim can be referenced without a prior write. */
export function claimIdFor(skuId: string, r: VrpResult): string {
  const h = createHash("sha256")
    .update(`${skuId}|${r.status}|${r.vrpAmount?.toString() ?? "-"}|${r.priceAmount?.toString() ?? "-"}|${r.chainStartMs ?? "-"}`)
    .digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const MAX_PRICE_PIASTRES = 10_000_000_000n;

export class PriceIntegrityError extends Error {
  override readonly name = "PriceIntegrityError";
  constructor(readonly code: "invalid_price" | "invalid_time", message: string) {
    super(message);
  }
}

/**
 * Orchestrates the pure domain over the ports. Implements the catalog's PriceBlockReader exactly,
 * so wiring it in is `prices: service`.
 */
export class PriceIntegrityService implements PriceBlockReader {
  constructor(private readonly d: PriceIntegrityDeps) {}

  /** PriceBlockReader: absent entries mean "no verified evidence" (catalog sanitises the rest). */
  async blocks(skuIds: readonly string[]): Promise<ReadonlyMap<string, PriceBlockInput>> {
    const out = new Map<string, PriceBlockInput>();
    const unique = [...new Set(skuIds)];
    if (unique.length === 0) return out;
    const nowMs = this.d.clock.nowMs();
    const [histories, external] = await Promise.all([this.d.events.historyMany(unique), this.d.external.lookup(unique)]);
    for (const skuId of unique) {
      const events = histories.get(skuId);
      if (events === undefined || events.length === 0) continue;
      const result = computeVrp({ events, nowMs, external: external.get(skuId) ?? null });
      out.set(skuId, toPriceBlock(result, claimIdFor(skuId, result)));
    }
    return out;
  }

  /** Appends a price change, then scores it: claim snapshot plus the enforcement ladder. */
  async recordPriceChange(input: RecordPriceChangeInput): Promise<PriceChangeOutcome> {
    if (input.priceAmount <= 0n || input.priceAmount > MAX_PRICE_PIASTRES) {
      throw new PriceIntegrityError("invalid_price", "price must be a positive integer number of piastres");
    }
    const nowMs = this.d.clock.nowMs();
    const validFromMs = input.validFromMs ?? nowMs;
    if (!Number.isInteger(validFromMs) || validFromMs > nowMs) {
      throw new PriceIntegrityError("invalid_time", "a price change cannot start in the future");
    }
    const neu: NewPriceEvent = {
      id: this.d.ids.uuidV7(),
      skuId: input.skuId,
      storeId: input.storeId,
      priceAmount: input.priceAmount,
      validFromMs,
      source: input.source,
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey,
    };
    // External evidence is read first so the `price.changed` signal can be computed inside the
    // append transaction, from the same history that includes the new event (fail closed on error).
    const external = (await this.d.external.lookup([input.skuId])).get(input.skuId) ?? null;
    const { event, created } = await this.d.events.append(neu, (h) => {
      const r = computeVrp({ events: h, nowMs, external });
      return { verified: r.claimAllowed, anomaly: detectPreDropInflation(h, nowMs) || r.inflationReset };
    });
    const history = await this.d.events.history(input.skuId);
    const result = computeVrp({ events: history, nowMs, external });
    const claimId = claimIdFor(input.skuId, result);
    if (!created) return { created, event, result, claimId, actions: [] };

    if (result.priceAmount !== null) {
      await this.d.claims.record({
        id: claimId,
        skuId: input.skuId,
        storeId: input.storeId,
        status: result.status,
        priceAmount: result.priceAmount,
        vrpAmount: result.claimAllowed ? result.vrpAmount : null,
        discountPct: result.claimAllowed ? result.discountPct : null,
        evidenceIds: result.evidence.map((e) => e.id),
        reason: result.reason,
        computedAtMs: nowMs,
      });
    }

    const actions: EnforcementAction[] = [];
    if (detectPreDropInflation(history, nowMs)) {
      const chain = normalizeEvents(history, nowMs);
      const last = chain[chain.length - 1];
      actions.push(...(await this.violation(input.storeId, input.skuId, "pre_drop_inflation", `pre_drop:${input.skuId}:${last?.id ?? "-"}`, nowMs)));
    }
    actions.push(...(await this.syncCrossChannel(input.storeId, input.skuId, result.crossChannelCheaper, nowMs)));
    return { created, event, result, claimId, actions };
  }

  /**
   * Seller-asserted reference (an import row or API field). It is never displayed as given: the
   * output is the verified block, and an inflated or unsupported assertion walks the ladder.
   */
  async reviewClaim(input: { skuId: string; storeId: string; claimedReferenceAmount: bigint | null }): Promise<ClaimReview> {
    const nowMs = this.d.clock.nowMs();
    const history = await this.d.events.history(input.skuId);
    const external = (await this.d.external.lookup([input.skuId])).get(input.skuId) ?? null;
    const result = computeVrp({ events: history, nowMs, external });
    const display = toPriceBlock(result, claimIdFor(input.skuId, result));
    const claimed = input.claimedReferenceAmount;
    if (claimed === null) return { display, corrected: false, actions: [] };
    const day = Math.floor(nowMs / MS_PER_DAY);
    if (!result.claimAllowed || result.vrpAmount === null) {
      const actions = await this.violation(input.storeId, input.skuId, "insufficient_evidence", `claim:${input.skuId}:${claimed}:${day}:none`, nowMs);
      return { display, corrected: true, actions };
    }
    if (claimed > result.vrpAmount) {
      const actions = await this.violation(input.storeId, input.skuId, "claim_exceeds_vrp", `claim:${input.skuId}:${claimed}:${day}`, nowMs);
      return { display, corrected: true, actions };
    }
    return { display, corrected: false, actions: [] };
  }

  async evidenceForProduct(productId: string): Promise<ProductEvidenceView | null> {
    const product = await this.d.directory.forProduct(productId);
    if (product === null || !product.active) return null;
    const nowMs = this.d.clock.nowMs();
    const [histories, external] = await Promise.all([this.d.events.historyMany(product.skuIds), this.d.external.lookup(product.skuIds)]);
    const skus: SkuEvidenceView[] = [];
    for (const skuId of product.skuIds) {
      const events = normalizeEvents(histories.get(skuId) ?? [], nowMs);
      if (events.length === 0) continue;
      const result = computeVrp({ events, nowMs, external: external.get(skuId) ?? null });
      const claimId = claimIdFor(skuId, result);
      skus.push({
        skuId,
        result,
        claimId,
        block: toPriceBlock(result, claimId),
        lowest30dAmount: lowestInWindow(events, nowMs),
        history: historyInWindow(events, nowMs),
      });
    }
    return { productId, computedAtMs: nowMs, skus };
  }

  /** Seller dashboard figures for the store's own claims and violations (90 days). */
  async trustForStore(storeId: string): Promise<StoreTrustView> {
    const nowMs = this.d.clock.nowMs();
    const since = nowMs - VIOLATION_LOOKBACK_MS;
    const [violations, open, stats, corrected, recent] = await Promise.all([
      this.d.enforcement.countSince(storeId, since),
      this.d.enforcement.openCrossChannelCount(storeId),
      this.d.claims.statsSince(storeId, since),
      this.d.enforcement.countKindSince(storeId, "claim_exceeds_vrp", since),
      this.d.enforcement.recent(storeId, 20),
    ]);
    const score = priceTrustScore({
      violationsInWindow: violations,
      openCrossChannelFindings: open,
      claimsEvaluated: stats.evaluated,
      claimsAutoCorrected: corrected,
    });
    return {
      storeId,
      score,
      band: trustBand(score),
      windowDays: 90,
      violations,
      openCrossChannelFindings: open,
      claimsEvaluated: stats.evaluated,
      claimsVerified: stats.verified,
      claimsAutoCorrected: corrected,
      recent,
    };
  }

  /** Evidence trail for an order line (spec 9.3 Snapshots). Null when the SKU has no price history. */
  async snapshotFor(skuId: string): Promise<VrpSnapshot | null> {
    const nowMs = this.d.clock.nowMs();
    const history = await this.d.events.history(skuId);
    if (history.length === 0) return null;
    const external = (await this.d.external.lookup([skuId])).get(skuId) ?? null;
    return toSnapshot(computeVrp({ events: history, nowMs, external }), nowMs);
  }

  private async violation(storeId: string, skuId: string, kind: ViolationKind, dedupeKey: string, nowMs: number): Promise<readonly EnforcementAction[]> {
    const prior = await this.d.enforcement.countSince(storeId, nowMs - VIOLATION_LOOKBACK_MS);
    const actions = decideEnforcement({ kind, violationsInWindow: prior + 1, crossChannelOpenSinceMs: null, nowMs });
    const stored = await this.d.enforcement.record({
      id: this.d.ids.uuidV7(),
      storeId,
      skuId,
      kind,
      actions,
      violationsInWindow: prior + 1,
      dedupeKey,
      openedAtMs: nowMs,
      resolvedAtMs: null,
    });
    return stored ? actions : [];
  }

  private async syncCrossChannel(storeId: string, skuId: string, cheaper: boolean, nowMs: number): Promise<readonly EnforcementAction[]> {
    const openSince = await this.d.enforcement.openCrossChannelSince(skuId);
    if (!cheaper) {
      if (openSince !== null) await this.d.enforcement.resolveCrossChannel(skuId, nowMs);
      return [];
    }
    if (openSince !== null) {
      const prior = await this.d.enforcement.countSince(storeId, nowMs - VIOLATION_LOOKBACK_MS);
      return decideEnforcement({ kind: "cross_channel_cheaper", violationsInWindow: prior, crossChannelOpenSinceMs: openSince, nowMs });
    }
    return this.violation(storeId, skuId, "cross_channel_cheaper", `xchan:${skuId}:${nowMs}`, nowMs);
  }
}

/** Lowest price in force during the last 30 days, including the price in force at the window start. */
function lowestInWindow(events: readonly PriceEvent[], nowMs: number): bigint | null {
  let best: bigint | null = null;
  for (const e of historyInWindow(events, nowMs)) if (best === null || e.priceAmount < best) best = e.priceAmount;
  return best;
}

function historyInWindow(events: readonly PriceEvent[], nowMs: number): { priceAmount: bigint; validFromMs: number }[] {
  const start = nowMs - WINDOW_MS;
  const out: { priceAmount: bigint; validFromMs: number }[] = [];
  events.forEach((e, i) => {
    const next = events[i + 1];
    if (next === undefined || next.validFromMs > start) out.push({ priceAmount: e.priceAmount, validFromMs: e.validFromMs });
  });
  return out;
}
