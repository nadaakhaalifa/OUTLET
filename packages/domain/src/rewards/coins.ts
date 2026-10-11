import { divideRoundHalfEven } from "../money";
import type { RewardsConfig } from "./config";
import { InvalidCoinInputError } from "./errors";
import { addMonthsUtc } from "../store-credit/rules";

const cap = (n: bigint, c: RewardsConfig): bigint => (n > c.maxCoinsPerEvent ? c.maxCoinsPerEvent : n);

/**
 * Coins for a delivered, closed, not-returned order. Net merchandise in piastres (after item level
 * discounts, before delivery fee). Rounds once, half to even, through the money core. Plus members
 * get a multiplier (entitlement `commerce_benefits.coins_plus_5pct`).
 */
export function purchaseCoins(cfg: RewardsConfig, netMerchandise: bigint, plus: boolean): bigint {
  if (netMerchandise < 0n) throw new InvalidCoinInputError("net merchandise must not be negative");
  const piastres = divideRoundHalfEven(netMerchandise * cfg.purchaseBps, 10_000n);
  let coins = piastres / cfg.piastresPerCoin;
  if (plus) coins = divideRoundHalfEven(coins * (10_000n + cfg.plusBonusBps), 10_000n);
  return cap(coins, cfg);
}

/**
 * Review coins. The signature has no rating on purpose: the same text, photo and fit info earns
 * the same coins at 1 and at 5 stars (spec 27, no incentivized-review bias). A photo review needs
 * size info to earn the full amount; a photo alone earns the photo part.
 */
export function reviewCoins(cfg: RewardsConfig, intent: { readonly hasPhoto: boolean; readonly hasFitInfo: boolean }): bigint {
  let coins = cfg.reviewBaseCoins;
  if (intent.hasPhoto) coins += cfg.reviewPhotoCoins;
  if (intent.hasFitInfo) coins += cfg.reviewFitCoins;
  return cap(coins, cfg);
}

export interface DebtNetting {
  /** Coins used to pay down debt (never posted to the ledger). */
  readonly netted: bigint;
  /** Coins that become credit. */
  readonly postable: bigint;
  readonly remainingDebt: bigint;
}

/** Earnings first pay down negative goodwill debt (clawback of already spent coins). Never charged. */
export function netAgainstDebt(debt: bigint, gross: bigint): DebtNetting {
  if (debt < 0n || gross < 0n) throw new InvalidCoinInputError("debt and gross must not be negative");
  const netted = debt < gross ? debt : gross;
  return { netted, postable: gross - netted, remainingDebt: debt - netted };
}

/**
 * Coins to claw back for a (partial) refund of an order. Proportional to refunded merchandise,
 * half to even once, capped by what is still clawable; a full refund claws the exact remainder so
 * the sum over several partial refunds can never exceed what was earned.
 */
export function clawbackCoins(input: {
  readonly earned: bigint;
  readonly alreadyClawed: bigint;
  readonly orderNetMerchandise: bigint;
  readonly refundedNetMerchandise: bigint;
  readonly cumulativeRefunded: bigint;
}): bigint {
  const { earned, alreadyClawed, orderNetMerchandise, refundedNetMerchandise, cumulativeRefunded } = input;
  if (earned < 0n || alreadyClawed < 0n || refundedNetMerchandise < 0n || orderNetMerchandise <= 0n) {
    throw new InvalidCoinInputError("invalid clawback input");
  }
  const remaining = earned - alreadyClawed;
  if (remaining <= 0n || refundedNetMerchandise === 0n) return 0n;
  if (cumulativeRefunded >= orderNetMerchandise) return remaining;
  const part = divideRoundHalfEven(earned * refundedNetMerchandise, orderNetMerchandise);
  return part > remaining ? remaining : part;
}

/** One earned lot with what is still backed by credit. */
export interface CoinLot {
  readonly id: string;
  readonly expiresAtMs: number;
  /** Coins posted to credit and not yet clawed back or expired. */
  readonly remaining: bigint;
}

export interface ExpiryStep {
  readonly lotId: string;
  readonly coins: bigint;
}

/**
 * Plans expiry. Spend takes the soonest expiring credit first (spec 15.2), so the credit that was
 * spent is attributed to the oldest lots first and what is left of an expired lot is the part that
 * is really still unspent. `balancePiastres` is the live cashback_coins balance from store credit.
 * Only the unspent part is written off, which is never more than the live balance.
 */
export function planCoinExpiry(
  lots: readonly CoinLot[],
  balancePiastres: bigint,
  piastresPerCoin: bigint,
  nowMs: number,
): ExpiryStep[] {
  const ordered = [...lots].filter((l) => l.remaining > 0n).sort((a, b) => a.expiresAtMs - b.expiresAtMs || (a.id < b.id ? -1 : 1));
  const totalCoins = ordered.reduce((a, l) => a + l.remaining, 0n);
  const liveCoins = balancePiastres / piastresPerCoin;
  let spent = totalCoins > liveCoins ? totalCoins - liveCoins : 0n;
  const steps: ExpiryStep[] = [];
  for (const lot of ordered) {
    const eaten = spent < lot.remaining ? spent : lot.remaining;
    spent -= eaten;
    const unspent = lot.remaining - eaten;
    if (lot.expiresAtMs <= nowMs && unspent > 0n) steps.push({ lotId: lot.id, coins: unspent });
  }
  return steps;
}

/** Coins awarded at `atMs` expire after the configured rolling window. */
export const coinExpiryMs = (cfg: RewardsConfig, atMs: number): number => addMonthsUtc(atMs, cfg.expiryMonths);

/** Real expiry only: lots expiring inside the notice window and the coins in them. */
export function expiringSoon(lots: readonly CoinLot[], nowMs: number, noticeDays: number): { coins: bigint; earliestMs: number | null } {
  const until = nowMs + noticeDays * 86_400_000;
  let coins = 0n;
  let earliest: number | null = null;
  for (const l of lots) {
    if (l.remaining > 0n && l.expiresAtMs > nowMs && l.expiresAtMs <= until) {
      coins += l.remaining;
      earliest = earliest === null || l.expiresAtMs < earliest ? l.expiresAtMs : earliest;
    }
  }
  return { coins, earliestMs: earliest };
}
