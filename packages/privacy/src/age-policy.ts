import { z } from 'zod';
import { AgePolicyError, InvalidInputError } from './errors.js';
import { addDays, type Clock, type Hasher, HEX_HASH, toIso } from './ports.js';

export const CAPABILITIES = [
  'account_create',
  'browse',
  'wishlist',
  'cart',
  'purchase',
  'plus_subscription',
  'bnpl',
  'gift_card_purchase_over_5000_egp',
  'corporate_b2b',
  'seller_signatory',
  'creator_payout',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Product rule: HAUL is 18+. No capability may ever be configured below this. */
export const ABSOLUTE_MIN_AGE = 18;
/** Civil Code age of majority. VERIFY BEFORE LAUNCH (B6). */
export const DEFAULT_AGE_OF_MAJORITY = 21;

export type AgePolicyTable = Readonly<Record<Capability, number>>;

/** Spec B6 defaults. BNPL is "provider rule (typically 21)": VERIFY per provider. */
export const DEFAULT_AGE_POLICY: AgePolicyTable = {
  account_create: 18,
  browse: 18,
  wishlist: 18,
  cart: 18,
  purchase: 18,
  plus_subscription: 21,
  bnpl: 21,
  gift_card_purchase_over_5000_egp: 21,
  corporate_b2b: 21,
  seller_signatory: 21,
  creator_payout: 21,
};

const MinAge = z.number().int().min(ABSOLUTE_MIN_AGE).max(120);
export const AgePolicyTableSchema = z
  .object(Object.fromEntries(CAPABILITIES.map((c) => [c, MinAge])) as Record<Capability, typeof MinAge>)
  .strict();

/** Parse an admin-supplied table. Anything below 18 is rejected, never clamped. */
export function parseAgePolicyTable(input: unknown): AgePolicyTable {
  const r = AgePolicyTableSchema.safeParse(input);
  if (!r.success) throw new AgePolicyError(`Invalid age policy: ${r.error.message}`);
  return r.data;
}

export interface CivilDate {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
}

const CivilDateSchema = z
  .object({ year: z.number().int().min(1900), month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) })
  .strict();

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function parseCivilDate(input: unknown): CivilDate {
  const r = CivilDateSchema.safeParse(input);
  if (!r.success) throw new InvalidInputError(`Invalid date: ${r.error.message}`);
  if (r.data.day > daysInMonth(r.data.year, r.data.month)) throw new InvalidInputError('Invalid calendar date');
  return r.data;
}

/** Whole years completed on `today`. Throws if DOB is in the future. Feb 29 birthdays count from Mar 1 in common years. */
export function ageOn(dob: CivilDate, today: CivilDate): number {
  const d = parseCivilDate(dob);
  const t = parseCivilDate(today);
  let age = t.year - d.year;
  if (t.month < d.month || (t.month === d.month && t.day < d.day)) age -= 1;
  if (age < 0) throw new InvalidInputError('Date of birth is in the future');
  return age;
}

export function civilDateFromClock(clock: Clock): CivilDate {
  const d = clock.now();
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export type AgeBand = 'under_18' | 'age_18_20' | 'age_21_plus';

export function ageBand(age: number, ageOfMajority: number = DEFAULT_AGE_OF_MAJORITY): AgeBand {
  if (age < ABSOLUTE_MIN_AGE) return 'under_18';
  return age < ageOfMajority ? 'age_18_20' : 'age_21_plus';
}

/** 18-20 are flagged limited_capacity (B6). */
export function isLimitedCapacity(age: number, ageOfMajority: number = DEFAULT_AGE_OF_MAJORITY): boolean {
  return ageBand(age, ageOfMajority) === 'age_18_20';
}

export type CapabilityDecision =
  | { readonly allowed: true; readonly minAge: number }
  | {
      readonly allowed: false;
      readonly minAge: number;
      /** hard: under 18, nothing is available. soft: show "requires N+" with a help link. */
      readonly gate: 'hard' | 'soft';
      readonly messageKey: 'age.requires_18' | 'age.requires_min_age';
    };

export function evaluateCapability(
  age: number,
  capability: Capability,
  table: AgePolicyTable = DEFAULT_AGE_POLICY,
): CapabilityDecision {
  // Re-check the floor even if a caller bypassed parseAgePolicyTable.
  const minAge = Math.max(table[capability], ABSOLUTE_MIN_AGE);
  if (age >= minAge) return { allowed: true, minAge };
  if (age < ABSOLUTE_MIN_AGE) return { allowed: false, minAge, gate: 'hard', messageKey: 'age.requires_18' };
  return { allowed: false, minAge, gate: 'soft', messageKey: 'age.requires_min_age' };
}

export const UNDER_18_BLOCK_DAYS = 30;

export const SoftBlockSchema = z
  .object({
    deviceHash: z.string().regex(HEX_HASH),
    blockedUntil: z.iso.datetime(),
  })
  .strict();
/** The only thing stored when an under-18 sign-up is refused: a hash and an expiry. No DOB, no age, no PII. */
export type DeviceSoftBlock = z.infer<typeof SoftBlockSchema>;

export function createSoftBlock(
  deviceId: string,
  hasher: Hasher,
  clock: Clock,
  days: number = UNDER_18_BLOCK_DAYS,
): DeviceSoftBlock {
  if (deviceId.length === 0) throw new InvalidInputError('deviceId required');
  if (!Number.isInteger(days) || days < 1) throw new InvalidInputError('days must be a positive integer');
  const deviceHash = hasher(deviceId);
  return SoftBlockSchema.parse({ deviceHash, blockedUntil: addDays(toIso(clock.now()), days) });
}

export function isDeviceBlocked(block: DeviceSoftBlock | undefined, deviceId: string, hasher: Hasher, clock: Clock): boolean {
  if (block === undefined) return false;
  return block.deviceHash === hasher(deviceId) && clock.now().getTime() < Date.parse(block.blockedUntil);
}

export type OnboardingAgeResult =
  | {
      readonly outcome: 'accepted';
      readonly age: number;
      readonly band: Exclude<AgeBand, 'under_18'>;
      readonly limitedCapacity: boolean;
    }
  | { readonly outcome: 'refused_under_18'; readonly block: DeviceSoftBlock }
  | { readonly outcome: 'refused_no_attestation' }
  | { readonly outcome: 'refused_device_blocked' };

export interface OnboardingAgeInput {
  readonly dob: CivilDate;
  readonly attestedAtLeast18: boolean;
  readonly deviceId: string;
  readonly existingBlock?: DeviceSoftBlock | undefined;
}

/**
 * DOB + attestation gate. On refusal nothing derived from the DOB is returned,
 * only the device soft-block.
 */
export function evaluateOnboardingAge(
  input: OnboardingAgeInput,
  hasher: Hasher,
  clock: Clock,
  table: AgePolicyTable = DEFAULT_AGE_POLICY,
  ageOfMajority: number = DEFAULT_AGE_OF_MAJORITY,
): OnboardingAgeResult {
  if (isDeviceBlocked(input.existingBlock, input.deviceId, hasher, clock)) {
    return { outcome: 'refused_device_blocked' };
  }
  const age = ageOn(input.dob, civilDateFromClock(clock));
  const minAccountAge = Math.max(table.account_create, ABSOLUTE_MIN_AGE);
  if (age < minAccountAge) {
    return { outcome: 'refused_under_18', block: createSoftBlock(input.deviceId, hasher, clock) };
  }
  if (!input.attestedAtLeast18) return { outcome: 'refused_no_attestation' };
  const band = ageBand(age, ageOfMajority);
  if (band === 'under_18') {
    return { outcome: 'refused_under_18', block: createSoftBlock(input.deviceId, hasher, clock) };
  }
  return { outcome: 'accepted', age, band, limitedCapacity: band === 'age_18_20' };
}
