import type { PriceBlockInput } from "../catalog/public-view";
import { money } from "../money";
import {
  EXTERNAL_STALE_MS,
  MATCH_CONF_TAU_BP,
  MIN_CLAIM_PCT,
  WINDOW_DAYS,
  WINDOW_MS,
  type EvidenceRef,
  type ExternalEvidence,
  type NoClaimReason,
  type PriceEvent,
  type VrpInput,
  type VrpResult,
  type VrpSnapshot,
} from "./types";

/**
 * Orders by time, drops non-positive prices and events from the future, and collapses consecutive
 * re-assertions of the same price (they are not a change and must not restart a discount run).
 */
export function normalizeEvents(events: readonly PriceEvent[], nowMs: number): readonly PriceEvent[] {
  const sorted = events
    .filter((e) => e.priceAmount > 0n && e.validFromMs <= nowMs)
    .slice()
    .sort((a, b) => (a.validFromMs !== b.validFromMs ? a.validFromMs - b.validFromMs : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: PriceEvent[] = [];
  for (const e of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && last.priceAmount === e.priceAmount) continue;
    out.push(e);
  }
  return out;
}

/** Events whose price was in force at some moment of [startMs, endMs) among the first `endIdx` events. */
function inForceDuring(events: readonly PriceEvent[], endIdx: number, startMs: number, endMs: number): PriceEvent[] {
  const out: PriceEvent[] = [];
  for (let i = 0; i < endIdx; i++) {
    const e = events[i];
    if (e === undefined) continue;
    const next = events[i + 1];
    const until = next === undefined ? Number.POSITIVE_INFINITY : next.validFromMs;
    if (e.validFromMs < endMs && until > startMs) out.push(e);
  }
  return out;
}

function hasIncrease(set: readonly PriceEvent[]): boolean {
  for (let i = 1; i < set.length; i++) {
    const a = set[i - 1];
    const b = set[i];
    if (a !== undefined && b !== undefined && b.priceAmount > a.priceAmount) return true;
  }
  return false;
}

function minOf(set: readonly PriceEvent[]): PriceEvent | null {
  let best: PriceEvent | null = null;
  for (const e of set) if (best === null || e.priceAmount < best.priceAmount) best = e;
  return best;
}

/** Index of the first reduction in the run of consecutive reductions ending at `k` (k itself must be a reduction). */
function runStartIndex(events: readonly PriceEvent[], k: number): number {
  let s = k;
  while (s > 1) {
    const a = events[s - 1];
    const b = events[s - 2];
    if (a === undefined || b === undefined || a.priceAmount >= b.priceAmount) break;
    s--;
  }
  return s;
}

type ExternalState = { readonly kind: "none" } | { readonly kind: "stale" } | { readonly kind: "usable"; readonly ev: ExternalEvidence };

/** Below-threshold or short-history evidence is ignored; matched-but-stale evidence blocks claims (fail closed). */
function externalState(ext: ExternalEvidence | null | undefined, nowMs: number): ExternalState {
  if (ext === null || ext === undefined) return { kind: "none" };
  if (!Number.isInteger(ext.matchConfBp) || ext.matchConfBp < MATCH_CONF_TAU_BP) return { kind: "none" };
  if (ext.historyDays < WINDOW_DAYS || ext.lowPriceAmount <= 0n) return { kind: "none" };
  if (nowMs - ext.observedAtMs > EXTERNAL_STALE_MS) return { kind: "stale" };
  return { kind: "usable", ev: ext };
}

/** Integer floor((vrp - price) * 100 / vrp) on piastres. Caller guarantees 0 < price < vrp. */
export function discountPercent(vrp: bigint, price: bigint): number {
  return Number(((vrp - price) * 100n) / vrp);
}

/**
 * Verified Reference Price (spec 9.3).
 *
 * Reference = the lowest price in force during the 30 days BEFORE the current run of consecutive
 * reductions began (so an increase just before a cut can never raise it: anti-inflation), further
 * lowered by fresh matched external evidence. Everything else fails closed to a plain price.
 */
export function computeVrp(input: VrpInput): VrpResult {
  const nowMs = input.nowMs;
  const events = normalizeEvents(input.events, nowMs);
  const base = {
    vrpAmount: null,
    discountPct: null,
    claimAllowed: false,
    inflationReset: false,
    chainStartMs: null,
    evidence: [] as readonly EvidenceRef[],
    externalUsed: false,
    crossChannelCheaper: false,
  } as const;
  const k = events.length - 1;
  const cur = events[k];
  const first = events[0];
  if (cur === undefined || first === undefined) {
    return { ...base, status: "none", priceAmount: null, reason: "no_history" };
  }
  const price = cur.priceAmount;
  const ext = externalState(input.external, nowMs);
  const crossChannelCheaper =
    ext.kind === "usable" && ext.ev.currentPriceAmount !== null && ext.ev.currentPriceAmount > 0n && ext.ev.currentPriceAmount < price;
  const plain = (status: VrpResult["status"], reason: NoClaimReason | null, extra: Partial<VrpResult> = {}): VrpResult => ({
    ...base,
    status,
    priceAmount: price,
    reason,
    crossChannelCheaper,
    ...extra,
  });

  // Launch price: listed for less than 30 days. Never a percentage.
  if (nowMs - first.validFromMs < WINDOW_MS) return plain("launch_price", "launch_window", { evidence: [{ kind: "price_event", id: first.id }] });

  let reason: NoClaimReason = "not_a_reduction";
  const prev = events[k - 1];
  if (prev !== undefined && price < prev.priceAmount) {
    const s = runStartIndex(events, k);
    const start = events[s];
    if (start === undefined) return plain("none", "no_history");
    const chainStartMs = start.validFromMs;
    const windowStart = chainStartMs - WINDOW_MS;
    if (nowMs - chainStartMs > WINDOW_MS) {
      reason = "discount_expired";
    } else if (first.validFromMs > windowStart) {
      reason = "insufficient_history";
    } else if (ext.kind === "stale") {
      reason = "stale_external_evidence";
    } else {
      const window = inForceDuring(events, s, windowStart, chainStartMs);
      const low = minOf(window);
      if (low === null) {
        reason = "insufficient_history";
      } else {
        let vrp = low.priceAmount;
        const evidence: EvidenceRef[] = [{ kind: "price_event", id: low.id }];
        let externalUsed = false;
        if (ext.kind === "usable" && ext.ev.lowPriceAmount < vrp) {
          vrp = ext.ev.lowPriceAmount;
          externalUsed = true;
        }
        if (ext.kind === "usable") evidence.push({ kind: "external", id: ext.ev.id });
        evidence.push({ kind: "price_event", id: cur.id });
        if (vrp <= price) {
          reason = "reference_not_above_price";
        } else {
          const pct = discountPercent(vrp, price);
          if (pct < MIN_CLAIM_PCT) {
            reason = "below_threshold";
          } else {
            return {
              ...base,
              status: "verified_discount",
              priceAmount: price,
              vrpAmount: vrp,
              discountPct: pct,
              claimAllowed: true,
              reason: null,
              inflationReset: hasIncrease(window),
              chainStartMs,
              evidence,
              externalUsed,
              crossChannelCheaper,
            };
          }
        }
      }
    }
  }

  // "Lowest price in 30 days": the 30-day window is fully covered, the current price is the lowest
  // in it, and at least one higher price was in force (a constant price is not a low).
  const windowStart = nowMs - WINDOW_MS;
  if (first.validFromMs <= windowStart && reason !== "stale_external_evidence") {
    const win = inForceDuring(events, events.length, windowStart, nowMs + 1);
    const lowest = minOf(win);
    const someHigher = win.some((e) => e.priceAmount > price);
    const beatenExternally = ext.kind === "usable" && ext.ev.lowPriceAmount < price;
    if (lowest !== null && lowest.priceAmount === price && someHigher && !beatenExternally) {
      return plain("lowest_30d", reason, { evidence: [{ kind: "price_event", id: cur.id }] });
    }
  }
  return plain("none", reason);
}

/** Maps a result onto the only shape the catalog may show. A percentage never exists without a verified claim. */
export function toPriceBlock(result: VrpResult, claimId: string | null): PriceBlockInput {
  if (result.status === "verified_discount" && result.claimAllowed && result.vrpAmount !== null && result.discountPct !== null && claimId !== null) {
    return { badge: "verified_discount", referencePrice: money(result.vrpAmount, "EGP"), discountPct: result.discountPct, claimId };
  }
  if (result.status === "lowest_30d") return { badge: "lowest_30d", referencePrice: null, discountPct: null, claimId };
  if (result.status === "launch_price") return { badge: "launch_price", referencePrice: null, discountPct: null, claimId };
  return { badge: "none", referencePrice: null, discountPct: null, claimId: null };
}

/** Evidence trail stored on every order line (spec 9.3). */
export function toSnapshot(result: VrpResult, nowMs: number): VrpSnapshot {
  return {
    priceAmount: result.priceAmount,
    vrpAmount: result.claimAllowed ? result.vrpAmount : null,
    discountPct: result.claimAllowed ? result.discountPct : null,
    claimType: result.status,
    evidenceIds: result.evidence.map((e) => e.id),
    computedAtMs: nowMs,
  };
}

/**
 * Pre-drop inflation (spec 9.4/9.5): the current price is a reduction and the price was raised
 * inside the 30 days before the run of reductions began. The claim itself is already honest
 * (anti-inflation reference); this flags the seller behaviour for the enforcement ladder.
 */
export function detectPreDropInflation(events: readonly PriceEvent[], nowMs: number): boolean {
  const ev = normalizeEvents(events, nowMs);
  const k = ev.length - 1;
  const cur = ev[k];
  const prev = ev[k - 1];
  if (cur === undefined || prev === undefined || cur.priceAmount >= prev.priceAmount) return false;
  const start = ev[runStartIndex(ev, k)];
  if (start === undefined) return false;
  return hasIncrease(inForceDuring(ev, runStartIndex(ev, k), start.validFromMs - WINDOW_MS, start.validFromMs));
}
