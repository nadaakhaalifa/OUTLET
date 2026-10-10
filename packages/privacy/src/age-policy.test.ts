import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ABSOLUTE_MIN_AGE, CAPABILITIES, DEFAULT_AGE_POLICY, ageBand, ageOn, evaluateCapability,
  evaluateOnboardingAge, isDeviceBlocked, parseAgePolicyTable, createSoftBlock, SoftBlockSchema,
  type AgePolicyTable,
} from './age-policy.js';
import { fakeHasher, fixedClock } from './fixtures.js';

const clock = fixedClock('2026-10-10T12:00:00.000Z');

describe('age policy defaults', () => {
  it('matches B6', () => {
    expect(DEFAULT_AGE_POLICY.purchase).toBe(18);
    expect(DEFAULT_AGE_POLICY.cart).toBe(18);
    expect(DEFAULT_AGE_POLICY.plus_subscription).toBe(21);
    expect(DEFAULT_AGE_POLICY.bnpl).toBe(21);
    expect(DEFAULT_AGE_POLICY.gift_card_purchase_over_5000_egp).toBe(21);
    expect(DEFAULT_AGE_POLICY.creator_payout).toBe(21);
  });
  it('admin can switch Plus to 18 but never below 18', () => {
    expect(parseAgePolicyTable({ ...DEFAULT_AGE_POLICY, plus_subscription: 18 }).plus_subscription).toBe(18);
    expect(() => parseAgePolicyTable({ ...DEFAULT_AGE_POLICY, purchase: 17 })).toThrow();
    expect(() => parseAgePolicyTable({ ...DEFAULT_AGE_POLICY, extra: 21 })).toThrow();
  });
});

describe('DOB to age', () => {
  it('handles birthdays and leap days', () => {
    expect(ageOn({ year: 2008, month: 10, day: 10 }, { year: 2026, month: 10, day: 10 })).toBe(18);
    expect(ageOn({ year: 2008, month: 10, day: 11 }, { year: 2026, month: 10, day: 10 })).toBe(17);
    expect(ageOn({ year: 2008, month: 2, day: 29 }, { year: 2026, month: 2, day: 28 })).toBe(17);
    expect(ageOn({ year: 2008, month: 2, day: 29 }, { year: 2026, month: 3, day: 1 })).toBe(18);
  });
  it('rejects invalid and future dates', () => {
    expect(() => ageOn({ year: 2027, month: 1, day: 1 }, { year: 2026, month: 1, day: 1 })).toThrow();
    expect(() => ageOn({ year: 2001, month: 2, day: 30 }, { year: 2026, month: 1, day: 1 })).toThrow();
  });
  it('bands', () => {
    expect(ageBand(17)).toBe('under_18');
    expect(ageBand(18)).toBe('age_18_20');
    expect(ageBand(20)).toBe('age_18_20');
    expect(ageBand(21)).toBe('age_21_plus');
  });
});

describe('capabilities', () => {
  it('soft gates 18-20 on 21+ capabilities and hard gates under 18', () => {
    expect(evaluateCapability(19, 'plus_subscription')).toMatchObject({ allowed: false, gate: 'soft', minAge: 21 });
    expect(evaluateCapability(19, 'purchase')).toEqual({ allowed: true, minAge: 18 });
    expect(evaluateCapability(16, 'browse')).toMatchObject({ allowed: false, gate: 'hard' });
  });
  it('property: never allowed below the minimum age, and always allowed at or above it', () => {
    const tableArb = fc.record(
      Object.fromEntries(CAPABILITIES.map((c) => [c, fc.integer({ min: 18, max: 30 })])) as Record<string, fc.Arbitrary<number>>,
    ) as fc.Arbitrary<AgePolicyTable>;
    fc.assert(fc.property(tableArb, fc.integer({ min: 0, max: 110 }), fc.constantFrom(...CAPABILITIES), (t, age, cap) => {
      const d = evaluateCapability(age, cap, t);
      const min = t[cap];
      return d.allowed === age >= min && (!d.allowed || age >= min) && (age >= ABSOLUTE_MIN_AGE || !d.allowed);
    }));
  });
  it('property: floor holds even for an unvalidated table with values below 18', () => {
    fc.assert(fc.property(fc.integer({ min: -5, max: 17 }), fc.constantFrom(...CAPABILITIES), (age, cap) => {
      const bad = { ...DEFAULT_AGE_POLICY, [cap]: 0 } as AgePolicyTable;
      return !evaluateCapability(age, cap, bad).allowed;
    }));
  });
});

describe('onboarding and soft block', () => {
  const dobFor = (age: number) => ({ year: 2026 - age - 1, month: 12, day: 31 });
  it('refuses under 18 and stores only a hash and expiry', () => {
    const r = evaluateOnboardingAge({ dob: dobFor(16), attestedAtLeast18: true, deviceId: 'device-xyz' }, fakeHasher, clock);
    expect(r.outcome).toBe('refused_under_18');
    if (r.outcome !== 'refused_under_18') throw new Error('unreachable');
    expect(Object.keys(r.block).sort()).toEqual(['blockedUntil', 'deviceHash']);
    expect(JSON.stringify(r)).not.toContain('device-xyz');
    expect(r.block.blockedUntil).toBe('2026-11-09T12:00:00.000Z');
    expect(SoftBlockSchema.safeParse({ ...r.block, dob: '2010-01-01' }).success).toBe(false);
  });
  it('blocks the same device for 30 days, then releases', () => {
    const block = createSoftBlock('dev-1', fakeHasher, clock);
    expect(isDeviceBlocked(block, 'dev-1', fakeHasher, clock)).toBe(true);
    expect(isDeviceBlocked(block, 'dev-2', fakeHasher, clock)).toBe(false);
    expect(isDeviceBlocked(block, 'dev-1', fakeHasher, fixedClock('2026-11-09T12:00:00.000Z'))).toBe(false);
    const r = evaluateOnboardingAge({ dob: dobFor(30), attestedAtLeast18: true, deviceId: 'dev-1', existingBlock: block }, fakeHasher, clock);
    expect(r.outcome).toBe('refused_device_blocked');
  });
  it('requires attestation', () => {
    expect(evaluateOnboardingAge({ dob: dobFor(30), attestedAtLeast18: false, deviceId: 'd' }, fakeHasher, clock).outcome)
      .toBe('refused_no_attestation');
  });
  it('flags limited_capacity for 18-20 only', () => {
    expect(evaluateOnboardingAge({ dob: dobFor(19), attestedAtLeast18: true, deviceId: 'd' }, fakeHasher, clock))
      .toMatchObject({ outcome: 'accepted', limitedCapacity: true, band: 'age_18_20' });
    expect(evaluateOnboardingAge({ dob: dobFor(25), attestedAtLeast18: true, deviceId: 'd' }, fakeHasher, clock))
      .toMatchObject({ outcome: 'accepted', limitedCapacity: false });
  });
  it('property: any DOB under 18 is refused regardless of attestation', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 17 }), fc.boolean(), fc.string({ minLength: 1 }), (age, att, dev) => {
      const r = evaluateOnboardingAge({ dob: dobFor(age), attestedAtLeast18: att, deviceId: dev }, fakeHasher, clock);
      return r.outcome === 'refused_under_18' || r.outcome === 'refused_device_blocked';
    }));
  });
});
