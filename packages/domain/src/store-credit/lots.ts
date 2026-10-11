import {
  planStoreCreditSpend,
  subBalanceKey,
  type StoreCreditSub,
  type SubBalanceState,
} from "../chart-of-accounts";
import { money, type Money } from "../money";
import { InvalidCreditInputError } from "./errors";
import { EXPIRING_PLATFORM_KINDS } from "./rules";

/** One grant of credit. The ledger account is per sub-balance; lots carry expiry and holds. */
export interface CreditLot {
  readonly id: string;
  readonly userId: string;
  readonly sub: StoreCreditSub;
  readonly granted: bigint;
  readonly remaining: bigint;
  readonly held: bigint;
  readonly expiresAtMs: number | null;
  readonly createdAtMs: number;
}

export interface LotTake {
  readonly lotId: string;
  readonly sub: StoreCreditSub;
  readonly amount: Money;
}

export const isExpired = (lot: CreditLot, nowMs: number): boolean => lot.expiresAtMs !== null && lot.expiresAtMs <= nowMs;

/** Spendable now: not expired, not already held. */
export function availableOf(lot: CreditLot, nowMs: number): bigint {
  if (isExpired(lot, nowMs)) return 0n;
  const a = lot.remaining - lot.held;
  return a > 0n ? a : 0n;
}

/**
 * Plans a spend over lots. Sub-balances are ordered by `planStoreCreditSpend` (soonest-expiring
 * first, non-expiring next, refund_credit last), using each sub's earliest expiring lot; inside a
 * sub-balance the earliest-expiring lot is consumed first. Pure and deterministic.
 */
export function planLotSpend(lots: readonly CreditLot[], amount: Money, nowMs: number): LotTake[] {
  const usable = lots.filter((l) => availableOf(l, nowMs) > 0n);
  const bySub = new Map<string, CreditLot[]>();
  for (const l of usable) {
    const k = subBalanceKey(l.sub);
    const arr = bySub.get(k);
    if (arr === undefined) bySub.set(k, [l]);
    else arr.push(l);
  }
  const states: SubBalanceState[] = [];
  for (const group of bySub.values()) {
    const first = group[0];
    if (first === undefined) continue;
    const expiring = group.filter((l) => l.expiresAtMs !== null).map((l) => l.expiresAtMs as number);
    states.push({
      sub: first.sub,
      balance: money(group.reduce((a, l) => a + availableOf(l, nowMs), 0n)),
      expiresAt: expiring.length === 0 ? null : new Date(Math.min(...expiring)),
    });
  }
  const plan = planStoreCreditSpend(states, amount);
  const takes: LotTake[] = [];
  for (const step of plan) {
    const group = [...(bySub.get(subBalanceKey(step.sub)) ?? [])].sort((a, b) => {
      const ea = a.expiresAtMs ?? Number.POSITIVE_INFINITY;
      const eb = b.expiresAtMs ?? Number.POSITIVE_INFINITY;
      return ea !== eb ? ea - eb : a.createdAtMs !== b.createdAtMs ? a.createdAtMs - b.createdAtMs : a.id < b.id ? -1 : 1;
    });
    let need = step.amount.amount;
    for (const lot of group) {
      if (need === 0n) break;
      const have = availableOf(lot, nowMs);
      const take = have < need ? have : need;
      if (take > 0n) takes.push({ lotId: lot.id, sub: lot.sub, amount: money(take) });
      need -= take;
    }
    if (need !== 0n) throw new InvalidCreditInputError("lot plan out of step with the sub-balance plan");
  }
  return takes;
}

export interface SubBalanceView {
  readonly sub: StoreCreditSub;
  readonly available: bigint;
  readonly held: bigint;
  readonly nextExpiryMs: number | null;
}

export function balancesOf(lots: readonly CreditLot[], nowMs: number): SubBalanceView[] {
  const map = new Map<string, { sub: StoreCreditSub; available: bigint; held: bigint; next: number | null }>();
  for (const l of lots) {
    if (isExpired(l, nowMs) || l.remaining === 0n) continue;
    const k = subBalanceKey(l.sub);
    const cur = map.get(k) ?? { sub: l.sub, available: 0n, held: 0n, next: null };
    cur.available += availableOf(l, nowMs);
    cur.held += l.held;
    if (l.expiresAtMs !== null && (cur.next === null || l.expiresAtMs < cur.next)) cur.next = l.expiresAtMs;
    map.set(k, cur);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, v]) => ({ sub: v.sub, available: v.available, held: v.held, nextExpiryMs: v.next }));
}

export interface ExpiringSoon {
  readonly sub: StoreCreditSub;
  readonly lotId: string;
  readonly amount: Money;
  readonly expiresAtMs: number;
}

export function expiringSoon(lots: readonly CreditLot[], nowMs: number, windowMs: number): ExpiringSoon[] {
  return lots
    .filter((l) => l.expiresAtMs !== null && !isExpired(l, nowMs) && l.expiresAtMs <= nowMs + windowMs && l.remaining > 0n)
    .map((l) => ({ sub: l.sub, lotId: l.id, amount: money(l.remaining), expiresAtMs: l.expiresAtMs as number }))
    .sort((a, b) => a.expiresAtMs - b.expiresAtMs || (a.lotId < b.lotId ? -1 : 1));
}

/**
 * Lots to write off now. Only platform-funded sub-balances are written off (`storeCreditExpired`
 * cannot express refund credit, which never expires, or gift cards, whose breakage treatment is
 * undecided, VERIFY). Lots with an active hold wait for the next pass. Idempotent: written-off
 * lots have remaining 0 and are never selected again.
 */
export function planExpirySweep(lots: readonly CreditLot[], nowMs: number): CreditLot[] {
  return lots
    .filter(
      (l) =>
        l.remaining > 0n &&
        l.held === 0n &&
        isExpired(l, nowMs) &&
        EXPIRING_PLATFORM_KINDS.includes(l.sub.kind),
    )
    .sort((a, b) => (a.expiresAtMs ?? 0) - (b.expiresAtMs ?? 0) || (a.id < b.id ? -1 : 1));
}

export interface ProjectionDrift {
  readonly subKey: string;
  readonly projection: bigint;
  readonly ledger: bigint;
  readonly drift: bigint;
}

/**
 * Nightly reconciliation (spec 15.2): ledger balance per sub-balance (credit positive) against the
 * projection from lots. `capturedUnposted` adds back credit already consumed by a captured hold
 * whose order entry is not in the ledger yet, so a transient gap is not reported as drift.
 */
export function reconcileProjection(input: {
  readonly lots: readonly CreditLot[];
  readonly ledgerBySub: ReadonlyMap<string, bigint>;
  readonly capturedUnposted: ReadonlyMap<string, bigint>;
}): ProjectionDrift[] {
  const projection = new Map<string, bigint>();
  for (const l of input.lots) {
    const k = subBalanceKey(l.sub);
    projection.set(k, (projection.get(k) ?? 0n) + l.remaining);
  }
  for (const [k, v] of input.capturedUnposted) projection.set(k, (projection.get(k) ?? 0n) + v);
  const keys = new Set<string>([...projection.keys(), ...input.ledgerBySub.keys()]);
  const out: ProjectionDrift[] = [];
  for (const k of [...keys].sort()) {
    const p = projection.get(k) ?? 0n;
    const g = input.ledgerBySub.get(k) ?? 0n;
    if (p !== g) out.push({ subKey: k, projection: p, ledger: g, drift: p - g });
  }
  return out;
}
