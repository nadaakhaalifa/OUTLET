import { z } from 'zod';
import { DeletionError } from './errors.js';
import { addDays, type Clock, type Hasher, toIso } from './ports.js';

export const DEFAULT_COOLING_DAYS = 14;

export interface DeletionSnapshot {
  readonly openOrders: number;
  readonly openReturns: number;
  readonly openDisputes: number;
  /** Store-credit balance in minor units (piastres). Never negative. */
  readonly storeCreditMinor: bigint;
}

export const DeletionSnapshotSchema = z
  .object({
    openOrders: z.number().int().nonnegative(),
    openReturns: z.number().int().nonnegative(),
    openDisputes: z.number().int().nonnegative(),
    storeCreditMinor: z.bigint().nonnegative(),
  })
  .strict();

export type DeletionBlockerKind = 'open_orders' | 'open_returns' | 'open_disputes';
export interface DeletionBlocker {
  readonly kind: DeletionBlockerKind;
  readonly count: number;
}

export type DeletionEligibility =
  | { readonly eligible: false; readonly blockers: readonly DeletionBlocker[] }
  | {
      readonly eligible: true;
      /** Present when balance > 0: the UI must show it and get explicit acknowledgement. */
      readonly forfeitureWarning?: { readonly balanceMinor: bigint };
    };

export function evaluateDeletionEligibility(snapshot: DeletionSnapshot): DeletionEligibility {
  const s = DeletionSnapshotSchema.parse(snapshot);
  const blockers: DeletionBlocker[] = [];
  if (s.openOrders > 0) blockers.push({ kind: 'open_orders', count: s.openOrders });
  if (s.openReturns > 0) blockers.push({ kind: 'open_returns', count: s.openReturns });
  if (s.openDisputes > 0) blockers.push({ kind: 'open_disputes', count: s.openDisputes });
  if (blockers.length > 0) return { eligible: false, blockers };
  return s.storeCreditMinor > 0n
    ? { eligible: true, forfeitureWarning: { balanceMinor: s.storeCreditMinor } }
    : { eligible: true };
}

export type DeletionStatus = 'cooling' | 'cancelled' | 'erasing' | 'completed';

export interface DeletionRequest {
  readonly id: string;
  readonly userId: string;
  readonly status: DeletionStatus;
  readonly requestedAt: string;
  readonly coolingEndsAt: string;
  readonly forfeitedStoreCreditMinor: bigint;
  readonly updatedAt: string;
}

export function requestDeletion(
  input: { readonly id: string; readonly userId: string; readonly acknowledgedForfeiture: boolean },
  snapshot: DeletionSnapshot,
  clock: Clock,
  coolingDays: number = DEFAULT_COOLING_DAYS,
): DeletionRequest {
  if (!Number.isInteger(coolingDays) || coolingDays < 0) throw new DeletionError('coolingDays must be >= 0');
  const e = evaluateDeletionEligibility(snapshot);
  if (!e.eligible) throw new DeletionError(`Deletion blocked: ${e.blockers.map((b) => b.kind).join(', ')}`);
  const balance = e.forfeitureWarning?.balanceMinor ?? 0n;
  if (balance > 0n && !input.acknowledgedForfeiture) {
    throw new DeletionError('Store-credit forfeiture must be acknowledged');
  }
  const now = toIso(clock.now());
  return {
    id: input.id,
    userId: input.userId,
    status: 'cooling',
    requestedAt: now,
    coolingEndsAt: addDays(now, coolingDays),
    forfeitedStoreCreditMinor: balance,
    updatedAt: now,
  };
}

/** Cancel is allowed only during cooling (DELETE /v1/me/privacy/delete). */
export function cancelDeletion(req: DeletionRequest, clock: Clock): DeletionRequest {
  if (req.status !== 'cooling') throw new DeletionError(`Cannot cancel a ${req.status} deletion`);
  if (clock.now().getTime() >= Date.parse(req.coolingEndsAt)) {
    throw new DeletionError('Cooling period has ended');
  }
  return { ...req, status: 'cancelled', updatedAt: toIso(clock.now()) };
}

/**
 * Start erasure once cooling has ended. Blockers are re-checked: an order placed
 * during cooling must stop the erasure.
 */
export function beginErasure(req: DeletionRequest, snapshot: DeletionSnapshot, clock: Clock): DeletionRequest {
  if (req.status !== 'cooling') throw new DeletionError(`Cannot erase a ${req.status} deletion`);
  if (clock.now().getTime() < Date.parse(req.coolingEndsAt)) throw new DeletionError('Cooling period still running');
  const e = evaluateDeletionEligibility(snapshot);
  if (!e.eligible) throw new DeletionError(`Deletion blocked: ${e.blockers.map((b) => b.kind).join(', ')}`);
  return { ...req, status: 'erasing', updatedAt: toIso(clock.now()) };
}

export function completeErasure(req: DeletionRequest, clock: Clock): DeletionRequest {
  if (req.status !== 'erasing') throw new DeletionError(`Cannot complete a ${req.status} deletion`);
  return { ...req, status: 'completed', updatedAt: toIso(clock.now()) };
}

export type ErasureTreatment = 'erase' | 'pseudonymize_retain_legal';

/**
 * What happens to each data category on deletion. Legal retention periods are
 * VERIFY BEFORE LAUNCH (see retention.ts). Unlisted categories default to erase.
 */
export const ERASURE_PLAN: Readonly<Record<string, ErasureTreatment>> = {
  profile: 'erase',
  addresses: 'erase',
  contact_details: 'erase',
  measurements: 'erase',
  wishlist_and_history: 'erase',
  consents_marketing: 'erase',
  orders_and_invoices: 'pseudonymize_retain_legal',
  ledger_entries: 'pseudonymize_retain_legal',
  payments_and_raw_webhooks: 'pseudonymize_retain_legal',
  kyc: 'pseudonymize_retain_legal',
  audit_log: 'pseudonymize_retain_legal',
};

export function treatmentFor(category: string): ErasureTreatment {
  return ERASURE_PLAN[category] ?? 'erase';
}

/**
 * Stable pseudonym that replaces the user id in retained financial records.
 * The hasher must be keyed with a secret held outside the retained dataset.
 */
export function pseudonymFor(userId: string, hasher: Hasher): string {
  if (userId.length === 0) throw new DeletionError('userId required');
  return `del_${hasher(`user:${userId}`)}`;
}
