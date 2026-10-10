import { describe, expect, it } from 'vitest';
import {
  ABSOLUTE_MIN_AGE,
  AgePolicyError,
  CAPABILITIES,
  ConsentError,
  DEFAULT_AGE_POLICY,
  DEFAULT_COOLING_DAYS,
  DEFAULT_DSAR_SLA_DAYS,
  DEFAULT_RETENTION_SCHEDULE,
  DeletionError,
  DsarTransitionError,
  EXPORT_TARGET_HOURS,
  GATED_PROCESSING,
  InvalidInputError,
  PROCESSING_REQUIREMENTS,
  RetentionError,
  TERMINAL_DSAR_STATES,
  UNDER_18_BLOCK_DAYS,
  addDays,
  addMonths,
  ageBand,
  ageOn,
  beginErasure,
  canTransition,
  cancelDeletion,
  civilDateFromClock,
  completeErasure,
  consentStatus,
  consentView,
  createDsar,
  createSoftBlock,
  daysRemaining,
  defaultConsentView,
  evaluateCapability,
  evaluateDeletionEligibility,
  evaluateOnboardingAge,
  grantConsent,
  isDeviceBlocked,
  isLimitedCapacity,
  isOverdue,
  mayInitialise,
  parseAgePolicyTable,
  parseCivilDate,
  parseRetentionSchedule,
  pseudonymFor,
  requestDeletion,
  retentionExpiry,
  ruleFor,
  toIso,
  transitionDsar,
  treatmentFor,
  withdrawConsent,
  ERASURE_PLAN,
  CONSENT_PURPOSES,
  DSAR_STATES,
  type ConsentHistory,
  type ConsentInput,
  type ConsentPurpose,
  type DsarState,
  type RetentionRule,
} from './index.js';
import { fakeHasher, fixedClock } from './fixtures.js';

const T0 = '2026-03-10T12:00:00.000Z';
const clock = fixedClock(T0);
const HASH = 'a'.repeat(32);

// ---------------------------------------------------------------- ports
describe('ports helpers', () => {
  it('toIso rejects invalid dates with a RangeError message', () => {
    expect(() => toIso(new Date(NaN))).toThrow(RangeError);
    expect(() => toIso(new Date(NaN))).toThrow('Invalid Date');
    expect(toIso(new Date(T0))).toBe(T0);
  });
  it('addDays and addMonths are exact, with day clamping', () => {
    expect(addDays(T0, 1)).toBe('2026-03-11T12:00:00.000Z');
    expect(addDays(T0, 30)).toBe('2026-04-09T12:00:00.000Z');
    expect(addMonths('2026-01-31T10:20:30.400Z', 1)).toBe('2026-02-28T10:20:30.400Z');
    expect(addMonths('2024-01-31T00:00:00.000Z', 1)).toBe('2024-02-29T00:00:00.000Z');
    expect(addMonths('2026-03-15T23:59:59.999Z', 25)).toBe('2028-04-15T23:59:59.999Z');
    expect(addMonths('2026-12-31T00:00:00.000Z', 2)).toBe('2027-02-28T00:00:00.000Z');
    expect(addMonths('2026-05-31T00:00:00.000Z', 1)).toBe('2026-06-30T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------- age policy
describe('age policy parsing', () => {
  it('accepts the defaults and boundaries, rejects below 18, above 120, extras and gaps', () => {
    expect(parseAgePolicyTable(DEFAULT_AGE_POLICY)).toEqual(DEFAULT_AGE_POLICY);
    const base = { ...DEFAULT_AGE_POLICY };
    expect(parseAgePolicyTable({ ...base, browse: 18 }).browse).toBe(18);
    expect(parseAgePolicyTable({ ...base, browse: 120 }).browse).toBe(120);
    expect(() => parseAgePolicyTable({ ...base, browse: 17 })).toThrow(AgePolicyError);
    expect(() => parseAgePolicyTable({ ...base, browse: 17 })).toThrow('Invalid age policy: ');
    expect(() => parseAgePolicyTable({ ...base, browse: 121 })).toThrow(AgePolicyError);
    expect(() => parseAgePolicyTable({ ...base, browse: 18.5 })).toThrow(AgePolicyError);
    expect(() => parseAgePolicyTable({ ...base, extra: 18 })).toThrow(AgePolicyError);
    const { cart: _cart, ...missing } = base;
    expect(() => parseAgePolicyTable(missing)).toThrow(AgePolicyError);
    expect(CAPABILITIES).toHaveLength(11);
    expect(ABSOLUTE_MIN_AGE).toBe(18);
  });
});

describe('civil dates', () => {
  it('validates ranges and calendar days', () => {
    expect(parseCivilDate({ year: 2024, month: 2, day: 29 })).toEqual({ year: 2024, month: 2, day: 29 });
    expect(() => parseCivilDate({ year: 2023, month: 2, day: 29 })).toThrow('Invalid calendar date');
    expect(() => parseCivilDate({ year: 2026, month: 4, day: 31 })).toThrow('Invalid calendar date');
    expect(parseCivilDate({ year: 2026, month: 12, day: 31 }).day).toBe(31);
    for (const bad of [
      { year: 1899, month: 1, day: 1 },
      { year: 2026, month: 0, day: 1 },
      { year: 2026, month: 13, day: 1 },
      { year: 2026, month: 1, day: 0 },
      { year: 2026, month: 1, day: 32 },
      { year: 2026.5, month: 1, day: 1 },
      { year: 2026, month: 1, day: 1, extra: 1 },
      'x',
    ]) {
      expect(() => parseCivilDate(bad)).toThrow(InvalidInputError);
      expect(() => parseCivilDate(bad)).toThrow('Invalid date: ');
    }
    expect(parseCivilDate({ year: 1900, month: 1, day: 1 }).year).toBe(1900);
  });
  it('civilDateFromClock uses UTC month + 1', () => {
    expect(civilDateFromClock(fixedClock('2026-01-31T23:59:59.000Z'))).toEqual({ year: 2026, month: 1, day: 31 });
    expect(civilDateFromClock(fixedClock('2026-12-01T00:00:00.000Z'))).toEqual({ year: 2026, month: 12, day: 1 });
  });
  it('ageOn counts completed years and rejects future dates', () => {
    const today = { year: 2026, month: 3, day: 10 };
    expect(ageOn({ year: 2008, month: 3, day: 10 }, today)).toBe(18);
    expect(ageOn({ year: 2008, month: 3, day: 11 }, today)).toBe(17);
    expect(ageOn({ year: 2008, month: 4, day: 1 }, today)).toBe(17);
    expect(ageOn({ year: 2008, month: 2, day: 28 }, today)).toBe(18);
    expect(ageOn({ year: 2026, month: 3, day: 10 }, today)).toBe(0);
    expect(() => ageOn({ year: 2026, month: 3, day: 11 }, today)).toThrow('Date of birth is in the future');
    expect(() => ageOn({ year: 2027, month: 1, day: 1 }, today)).toThrow(InvalidInputError);
  });
});

describe('age bands and capabilities', () => {
  it('bands and limited capacity', () => {
    expect(ageBand(17)).toBe('under_18');
    expect(ageBand(18)).toBe('age_18_20');
    expect(ageBand(20)).toBe('age_18_20');
    expect(ageBand(21)).toBe('age_21_plus');
    expect(ageBand(18, 18)).toBe('age_21_plus');
    expect(ageBand(19, 25)).toBe('age_18_20');
    expect(isLimitedCapacity(17)).toBe(false);
    expect(isLimitedCapacity(18)).toBe(true);
    expect(isLimitedCapacity(20)).toBe(true);
    expect(isLimitedCapacity(21)).toBe(false);
    expect(isLimitedCapacity(30)).toBe(false);
    expect(isLimitedCapacity(19, 18)).toBe(false);
  });
  it('evaluateCapability decisions at the boundaries', () => {
    expect(evaluateCapability(21, 'plus_subscription')).toEqual({ allowed: true, minAge: 21 });
    expect(evaluateCapability(18, 'browse')).toEqual({ allowed: true, minAge: 18 });
    expect(evaluateCapability(20, 'plus_subscription')).toEqual({
      allowed: false,
      minAge: 21,
      gate: 'soft',
      messageKey: 'age.requires_min_age',
    });
    expect(evaluateCapability(17, 'browse')).toEqual({
      allowed: false,
      minAge: 18,
      gate: 'hard',
      messageKey: 'age.requires_18',
    });
    expect(evaluateCapability(17, 'plus_subscription')).toMatchObject({ gate: 'hard', minAge: 21 });
    expect(evaluateCapability(18, 'plus_subscription')).toMatchObject({ gate: 'soft', messageKey: 'age.requires_min_age' });
    const lax = { ...DEFAULT_AGE_POLICY, plus_subscription: 10 };
    expect(evaluateCapability(17, 'plus_subscription', lax)).toMatchObject({ allowed: false, minAge: 18, gate: 'hard' });
    expect(evaluateCapability(18, 'plus_subscription', lax)).toEqual({ allowed: true, minAge: 18 });
  });
});

describe('device soft block and onboarding', () => {
  it('creates a 30 day block holding only a hash and an expiry', () => {
    const b = createSoftBlock('dev-1', fakeHasher, clock);
    expect(b).toEqual({ deviceHash: fakeHasher('dev-1'), blockedUntil: '2026-04-09T12:00:00.000Z' });
    expect(UNDER_18_BLOCK_DAYS).toBe(30);
    expect(createSoftBlock('dev-1', fakeHasher, clock, 1).blockedUntil).toBe('2026-03-11T12:00:00.000Z');
    expect(() => createSoftBlock('', fakeHasher, clock)).toThrow('deviceId required');
    expect(() => createSoftBlock('d', fakeHasher, clock, 0)).toThrow('days must be a positive integer');
    expect(() => createSoftBlock('d', fakeHasher, clock, 1.5)).toThrow(InvalidInputError);
    expect(() => createSoftBlock('d', fakeHasher, clock, -3)).toThrow(InvalidInputError);
  });
  it('rejects hashers that do not return hex', () => {
    expect(() => createSoftBlock('d', () => 'NOT-HEX', clock)).toThrow();
    expect(() => createSoftBlock('d', () => `zz${'a'.repeat(32)}`, clock)).toThrow();
    expect(() => createSoftBlock('d', () => `${'a'.repeat(32)}zz`, clock)).toThrow();
    expect(() => createSoftBlock('d', () => 'a'.repeat(32), clock)).not.toThrow();
  });
  it('isDeviceBlocked checks device and strict expiry', () => {
    const b = createSoftBlock('dev-1', fakeHasher, clock);
    expect(isDeviceBlocked(undefined, 'dev-1', fakeHasher, clock)).toBe(false);
    expect(isDeviceBlocked(b, 'dev-1', fakeHasher, clock)).toBe(true);
    expect(isDeviceBlocked(b, 'dev-2', fakeHasher, clock)).toBe(false);
    expect(isDeviceBlocked(b, 'dev-1', fakeHasher, fixedClock('2026-04-09T11:59:59.999Z'))).toBe(true);
    expect(isDeviceBlocked(b, 'dev-1', fakeHasher, fixedClock('2026-04-09T12:00:00.000Z'))).toBe(false);
  });
  const input = (dob: { year: number; month: number; day: number }, attested = true, extra = {}) => ({
    dob,
    attestedAtLeast18: attested,
    deviceId: 'dev-1',
    ...extra,
  });
  it('accepts at exactly 18 and 21 with the right band', () => {
    expect(evaluateOnboardingAge(input({ year: 2008, month: 3, day: 10 }), fakeHasher, clock)).toEqual({
      outcome: 'accepted',
      age: 18,
      band: 'age_18_20',
      limitedCapacity: true,
    });
    expect(evaluateOnboardingAge(input({ year: 2005, month: 3, day: 10 }), fakeHasher, clock)).toEqual({
      outcome: 'accepted',
      age: 21,
      band: 'age_21_plus',
      limitedCapacity: false,
    });
    expect(evaluateOnboardingAge(input({ year: 2005, month: 3, day: 10 }), fakeHasher, clock, DEFAULT_AGE_POLICY, 25)).toMatchObject({
      band: 'age_18_20',
      limitedCapacity: true,
    });
  });
  it('refuses under 18 with only a device block, one day short of 18', () => {
    const r = evaluateOnboardingAge(input({ year: 2008, month: 3, day: 11 }), fakeHasher, clock);
    expect(r).toEqual({
      outcome: 'refused_under_18',
      block: { deviceHash: fakeHasher('dev-1'), blockedUntil: '2026-04-09T12:00:00.000Z' },
    });
  });
  it('refuses without attestation and for blocked devices', () => {
    expect(evaluateOnboardingAge(input({ year: 2000, month: 1, day: 1 }, false), fakeHasher, clock)).toEqual({
      outcome: 'refused_no_attestation',
    });
    const block = createSoftBlock('dev-1', fakeHasher, clock);
    expect(
      evaluateOnboardingAge(input({ year: 2000, month: 1, day: 1 }, true, { existingBlock: block }), fakeHasher, clock),
    ).toEqual({ outcome: 'refused_device_blocked' });
    // a block for another device does not apply
    const other = createSoftBlock('dev-9', fakeHasher, clock);
    expect(
      evaluateOnboardingAge(input({ year: 2000, month: 1, day: 1 }, true, { existingBlock: other }), fakeHasher, clock).outcome,
    ).toBe('accepted');
  });
  it('honours a stricter account_create age from the table', () => {
    const strict = { ...DEFAULT_AGE_POLICY, account_create: 21 };
    const r = evaluateOnboardingAge(input({ year: 2006, month: 1, day: 1 }), fakeHasher, clock, strict);
    expect(r.outcome).toBe('refused_under_18');
    const lax = { ...DEFAULT_AGE_POLICY, account_create: 10 };
    expect(evaluateOnboardingAge(input({ year: 2010, month: 1, day: 1 }), fakeHasher, clock, lax).outcome).toBe(
      'refused_under_18',
    );
  });
});

// ---------------------------------------------------------------- consent
describe('consent exact behaviour', () => {
  const inp = (over: Partial<ConsentInput> = {}): ConsentInput => ({
    userId: 'u1',
    purpose: 'analytics',
    version: 1,
    method: 'settings_toggle',
    ipHash: HASH,
    ...over,
  });
  const versions = Object.fromEntries(CONSENT_PURPOSES.map((p) => [p, 1])) as Record<ConsentPurpose, number>;

  it('records carry the capture time and explicit decision', () => {
    const h = grantConsent([], inp(), clock);
    expect(h).toEqual([
      { userId: 'u1', purpose: 'analytics', version: 1, granted: true, method: 'settings_toggle', at: T0, ipHash: HASH },
    ]);
    expect(withdrawConsent(h, inp(), clock)[1]?.granted).toBe(false);
    expect(h).toHaveLength(1); // input history is not mutated
  });
  it('validates records with a ConsentError', () => {
    for (const bad of [
      inp({ userId: '' }),
      inp({ version: 0 }),
      inp({ version: 1.5 }),
      inp({ ipHash: 'g'.repeat(32) }),
      inp({ ipHash: 'a'.repeat(15) }),
      inp({ ipHash: 'a'.repeat(129) }),
      inp({ ipHash: `zz${HASH}` }),
      inp({ ipHash: `${HASH}zz` }),
      inp({ purpose: 'nope' as ConsentPurpose }),
    ]) {
      expect(() => grantConsent([], bad, clock)).toThrow(ConsentError);
      expect(() => grantConsent([], bad, clock)).toThrow('Invalid consent record: ');
    }
    expect(() => grantConsent([], inp({ ipHash: 'a'.repeat(16) }), clock)).not.toThrow();
    expect(() => grantConsent([], inp({ ipHash: 'a'.repeat(128) }), clock)).not.toThrow();
  });
  it('latest record wins by time, and by append order on equal time', () => {
    const g = grantConsent([], inp(), clock);
    const w = withdrawConsent(g, inp(), clock); // same timestamp, appended later
    expect(consentStatus(w, 'u1', 'analytics', 1)).toBe('withdrawn');
    const regrant = grantConsent(w, inp(), clock);
    expect(consentStatus(regrant, 'u1', 'analytics', 1)).toBe('granted');
    // an earlier-timestamped record appended later must not override
    const early = withdrawConsent([], inp(), fixedClock('2026-03-01T00:00:00.000Z'));
    const late = grantConsent([], inp(), fixedClock('2026-03-02T00:00:00.000Z'));
    expect(consentStatus([...late, ...early], 'u1', 'analytics', 1)).toBe('granted');
    expect(consentStatus([...early, ...late], 'u1', 'analytics', 1)).toBe('granted');
  });
  it('status per user and purpose, re-consent on version bump', () => {
    const h: ConsentHistory = grantConsent([], inp({ version: 2 }), clock);
    expect(consentStatus(h, 'u1', 'analytics', 2)).toBe('granted');
    expect(consentStatus(h, 'u1', 'analytics', 3)).toBe('reconsent_required');
    expect(consentStatus(h, 'u1', 'analytics', 1)).toBe('granted');
    expect(consentStatus(h, 'u2', 'analytics', 1)).toBe('never_asked');
    expect(consentStatus(h, 'u1', 'personalization', 1)).toBe('never_asked');
  });
  it('default view is all false and consentView reflects only granted purposes', () => {
    const d = defaultConsentView();
    expect(Object.keys(d)).toEqual([...CONSENT_PURPOSES]);
    expect(Object.values(d).every((v) => v === false)).toBe(true);
    const h = grantConsent(grantConsent([], inp(), clock), inp({ purpose: 'measurements' }), clock);
    const v = consentView(h, 'u1', versions);
    expect(v.analytics).toBe(true);
    expect(v.measurements).toBe(true);
    expect(v.marketing_push).toBe(false);
    expect(Object.keys(v)).toEqual([...CONSENT_PURPOSES]);
  });
  it('processing requirements table is exact and gating fails closed', () => {
    expect(PROCESSING_REQUIREMENTS).toEqual({
      posthog: ['analytics'],
      sentry_breadcrumbs: ['analytics'],
      ads_sdk: ['analytics', 'personalization'],
      push_marketing: ['marketing_push'],
      whatsapp_marketing: ['marketing_whatsapp'],
      email_marketing: ['marketing_email'],
      personalization_engine: ['personalization'],
      budget_insights: ['budget_insights'],
      measurement_profile: ['measurements'],
      precise_location: ['location_precise'],
      external_ml_api: ['cross_border_ml'],
    });
    expect(Object.keys(PROCESSING_REQUIREMENTS)).toEqual([...GATED_PROCESSING]);
    for (const item of GATED_PROCESSING) {
      expect(mayInitialise(item, [], 'u1', versions)).toEqual({
        allowed: false,
        missing: PROCESSING_REQUIREMENTS[item].map((purpose) => ({ purpose, status: 'never_asked' })),
      });
      let h: ConsentHistory = [];
      for (const p of PROCESSING_REQUIREMENTS[item]) h = grantConsent(h, inp({ purpose: p }), clock);
      expect(mayInitialise(item, h, 'u1', versions)).toEqual({ allowed: true });
    }
    const partial = grantConsent([], inp({ purpose: 'analytics' }), clock);
    expect(mayInitialise('ads_sdk', partial, 'u1', versions)).toEqual({
      allowed: false,
      missing: [{ purpose: 'personalization', status: 'never_asked' }],
    });
    const stale = grantConsent([], inp({ purpose: 'marketing_push', version: 1 }), clock);
    expect(mayInitialise('push_marketing', stale, 'u1', { ...versions, marketing_push: 2 })).toEqual({
      allowed: false,
      missing: [{ purpose: 'marketing_push', status: 'reconsent_required' }],
    });
  });
});

// ---------------------------------------------------------------- deletion
describe('deletion exact behaviour', () => {
  const snap = (over: Partial<{ openOrders: number; openReturns: number; openDisputes: number; storeCreditMinor: bigint }> = {}) => ({
    openOrders: 0,
    openReturns: 0,
    openDisputes: 0,
    storeCreditMinor: 0n,
    ...over,
  });
  const req = { id: 'd1', userId: 'u1', acknowledgedForfeiture: false };

  it('eligibility lists every blocker with counts and handles balances', () => {
    expect(evaluateDeletionEligibility(snap())).toStrictEqual({ eligible: true });
    expect(evaluateDeletionEligibility(snap({ storeCreditMinor: 1n }))).toStrictEqual({
      eligible: true,
      forfeitureWarning: { balanceMinor: 1n },
    });
    expect(evaluateDeletionEligibility(snap({ openOrders: 2, openReturns: 3, openDisputes: 4 }))).toEqual({
      eligible: false,
      blockers: [
        { kind: 'open_orders', count: 2 },
        { kind: 'open_returns', count: 3 },
        { kind: 'open_disputes', count: 4 },
      ],
    });
    expect(evaluateDeletionEligibility(snap({ openReturns: 1, storeCreditMinor: 99n }))).toEqual({
      eligible: false,
      blockers: [{ kind: 'open_returns', count: 1 }],
    });
    expect(() => evaluateDeletionEligibility(snap({ openOrders: -1 }))).toThrow();
    expect(() => evaluateDeletionEligibility(snap({ storeCreditMinor: -1n }))).toThrow();
  });
  it('requestDeletion builds the cooling request', () => {
    expect(DEFAULT_COOLING_DAYS).toBe(14);
    expect(requestDeletion(req, snap(), clock)).toEqual({
      id: 'd1',
      userId: 'u1',
      status: 'cooling',
      requestedAt: T0,
      coolingEndsAt: '2026-03-24T12:00:00.000Z',
      forfeitedStoreCreditMinor: 0n,
      updatedAt: T0,
    });
    expect(requestDeletion(req, snap(), clock, 0).coolingEndsAt).toBe(T0);
    expect(() => requestDeletion(req, snap(), clock, -1)).toThrow('coolingDays must be >= 0');
    expect(() => requestDeletion(req, snap(), clock, 1.5)).toThrow(DeletionError);
  });
  it('blocked and forfeiture errors', () => {
    expect(() => requestDeletion(req, snap({ openOrders: 1, openDisputes: 1 }), clock)).toThrow(
      'Deletion blocked: open_orders, open_disputes',
    );
    expect(() => requestDeletion(req, snap({ openReturns: 1 }), clock)).toThrow('Deletion blocked: open_returns');
    expect(() => requestDeletion(req, snap({ storeCreditMinor: 5n }), clock)).toThrow(
      'Store-credit forfeiture must be acknowledged',
    );
    const r = requestDeletion({ ...req, acknowledgedForfeiture: true }, snap({ storeCreditMinor: 5n }), clock);
    expect(r.forfeitedStoreCreditMinor).toBe(5n);
  });
  it('cancel only during cooling, strictly before the end', () => {
    const r = requestDeletion(req, snap(), clock);
    const c = cancelDeletion(r, fixedClock('2026-03-24T11:59:59.999Z'));
    expect(c.status).toBe('cancelled');
    expect(c.updatedAt).toBe('2026-03-24T11:59:59.999Z');
    expect(() => cancelDeletion(r, fixedClock('2026-03-24T12:00:00.000Z'))).toThrow('Cooling period has ended');
    expect(() => cancelDeletion(c, clock)).toThrow('Cannot cancel a cancelled deletion');
    expect(() => cancelDeletion({ ...r, status: 'erasing' }, clock)).toThrow('Cannot cancel a erasing deletion');
  });
  it('erasure starts at the end of cooling and rechecks blockers', () => {
    const r = requestDeletion(req, snap(), clock);
    const end = fixedClock('2026-03-24T12:00:00.000Z');
    expect(() => beginErasure(r, snap(), fixedClock('2026-03-24T11:59:59.999Z'))).toThrow('Cooling period still running');
    const e = beginErasure(r, snap(), end);
    expect(e.status).toBe('erasing');
    expect(e.updatedAt).toBe('2026-03-24T12:00:00.000Z');
    expect(() => beginErasure(r, snap({ openOrders: 1 }), end)).toThrow('Deletion blocked: open_orders');
    expect(() => beginErasure(r, snap({ openOrders: 1, openReturns: 2 }), end)).toThrow(
      'Deletion blocked: open_orders, open_returns',
    );
    expect(() => beginErasure({ ...r, status: 'cancelled' }, snap(), end)).toThrow('Cannot erase a cancelled deletion');
    expect(() => beginErasure(e, snap(), end)).toThrow('Cannot erase a erasing deletion');
  });
  it('completion only from erasing', () => {
    const r = requestDeletion(req, snap(), clock);
    const e = beginErasure(r, snap(), fixedClock('2026-04-01T00:00:00.000Z'));
    const done = completeErasure(e, fixedClock('2026-04-02T00:00:00.000Z'));
    expect(done.status).toBe('completed');
    expect(done.updatedAt).toBe('2026-04-02T00:00:00.000Z');
    expect(() => completeErasure(r, clock)).toThrow('Cannot complete a cooling deletion');
    expect(() => completeErasure(done, clock)).toThrow('Cannot complete a completed deletion');
  });
  it('erasure plan and pseudonyms', () => {
    expect(ERASURE_PLAN).toEqual({
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
    });
    expect(treatmentFor('kyc')).toBe('pseudonymize_retain_legal');
    expect(treatmentFor('profile')).toBe('erase');
    expect(treatmentFor('something_new')).toBe('erase');
    const seen: string[] = [];
    expect(
      pseudonymFor('u1', (s) => {
        seen.push(s);
        return 'abc';
      }),
    ).toBe('del_abc');
    expect(seen).toEqual(['user:u1']);
    expect(() => pseudonymFor('', fakeHasher)).toThrow('userId required');
  });
});

// ---------------------------------------------------------------- dsar
describe('DSAR exact behaviour', () => {
  const inp = { id: 'r1', userId: 'u1', type: 'export' as const };
  it('creates requests with SLA and export target', () => {
    expect(DEFAULT_DSAR_SLA_DAYS).toBe(30);
    expect(EXPORT_TARGET_HOURS).toBe(72);
    expect(createDsar(inp, clock)).toEqual({
      id: 'r1',
      userId: 'u1',
      type: 'export',
      state: 'received',
      receivedAt: T0,
      dueAt: '2026-04-09T12:00:00.000Z',
      slaDays: 30,
      exportTargetAt: '2026-03-13T12:00:00.000Z',
      updatedAt: T0,
    });
    const del = createDsar({ ...inp, type: 'delete' }, clock, { slaDays: 1 });
    expect(del).toStrictEqual({
      id: 'r1',
      userId: 'u1',
      type: 'delete',
      state: 'received',
      receivedAt: T0,
      dueAt: '2026-03-11T12:00:00.000Z',
      slaDays: 1,
      updatedAt: T0,
    });
    expect(() => createDsar(inp, clock, { slaDays: 0 })).toThrow('slaDays must be a positive integer');
    expect(() => createDsar(inp, clock, { slaDays: 2.5 })).toThrow(InvalidInputError);
    expect(() => createDsar(inp, clock, { slaDays: -1 })).toThrow(InvalidInputError);
  });
  it('transition table is exact', () => {
    const allowed: Record<DsarState, DsarState[]> = {
      received: ['verifying_identity', 'rejected', 'cancelled'],
      verifying_identity: ['in_progress', 'rejected', 'cancelled'],
      in_progress: ['completed', 'rejected', 'cancelled'],
      completed: [],
      rejected: [],
      cancelled: [],
    };
    for (const from of DSAR_STATES) {
      for (const to of DSAR_STATES) expect(canTransition(from, to)).toBe(allowed[from].includes(to));
    }
    expect([...TERMINAL_DSAR_STATES]).toEqual(['completed', 'rejected', 'cancelled']);
  });
  it('transitions update state and timestamp, with exact errors', () => {
    const r = createDsar(inp, clock);
    const later = fixedClock('2026-03-11T00:00:00.000Z');
    const v = transitionDsar(r, 'verifying_identity', later);
    expect(v.state).toBe('verifying_identity');
    expect(v.updatedAt).toBe('2026-03-11T00:00:00.000Z');
    expect(v).not.toHaveProperty('rejectionReason');
    expect(() => transitionDsar(r, 'completed', clock)).toThrow(DsarTransitionError);
    expect(() => transitionDsar(r, 'completed', clock)).toThrow('DSAR r1: received -> completed is not allowed');
    expect(() => transitionDsar(r, 'rejected', clock)).toThrow('DSAR r1: rejection requires a reason');
    expect(() => transitionDsar(r, 'rejected', clock, { rejectionReason: '' })).toThrow(
      'DSAR r1: rejection requires a reason',
    );
    const rej = transitionDsar(r, 'rejected', later, { rejectionReason: 'identity_unverified' });
    expect(rej.rejectionReason).toBe('identity_unverified');
    const can = transitionDsar(r, 'cancelled', later, { rejectionReason: 'ignored' });
    expect(can).not.toHaveProperty('rejectionReason');
    expect(() => transitionDsar(rej, 'in_progress', later)).toThrow(DsarTransitionError);
  });
  it('overdue and days remaining use exact boundaries', () => {
    const r = createDsar(inp, clock, { slaDays: 1 });
    const due = '2026-03-11T12:00:00.000Z';
    expect(isOverdue(r, fixedClock(due))).toBe(false);
    expect(isOverdue(r, fixedClock('2026-03-11T12:00:00.001Z'))).toBe(true);
    const done = transitionDsar(transitionDsar(transitionDsar(r, 'verifying_identity', clock), 'in_progress', clock), 'completed', clock);
    expect(isOverdue(done, fixedClock('2026-12-01T00:00:00.000Z'))).toBe(false);
    expect(daysRemaining(r, clock)).toBe(1);
    expect(daysRemaining(r, fixedClock('2026-03-10T12:00:00.001Z'))).toBe(0);
    expect(daysRemaining(r, fixedClock(due))).toBe(0);
    expect(daysRemaining(r, fixedClock('2026-03-12T12:00:00.000Z'))).toBe(-1);
    expect(daysRemaining(r, fixedClock('2026-03-12T12:00:00.001Z'))).toBe(-2);
  });
});

// ---------------------------------------------------------------- retention
describe('retention exact behaviour', () => {
  it('default schedule is exactly the reviewed one', () => {
    expect(DEFAULT_RETENTION_SCHEDULE).toEqual([
      {
        category: 'orders_invoices',
        period: { kind: 'months', months: 84 },
        afterExpiry: 'delete',
        purgeMetric: 'privacy_purge_orders_invoices_total',
        verifyBeforeLaunch: true,
        note: 'Tax-law period; spec says assume 5-7 years, 7 used as the conservative upper bound.',
      },
      {
        category: 'kyc',
        period: { kind: 'after_contract_end_months', months: 60 },
        afterExpiry: 'delete',
        purgeMetric: 'privacy_purge_kyc_total',
        verifyBeforeLaunch: true,
        note: 'Contract + 5 years.',
      },
      {
        category: 'analytics_events',
        period: { kind: 'months', months: 25 },
        afterExpiry: 'aggregate',
        purgeMetric: 'privacy_purge_analytics_events_total',
        verifyBeforeLaunch: false,
      },
      {
        category: 'measurements',
        period: { kind: 'until_deletion' },
        afterExpiry: 'delete',
        purgeMetric: 'privacy_purge_measurements_total',
        verifyBeforeLaunch: false,
      },
      {
        category: 'support_chats',
        period: { kind: 'months', months: 24 },
        afterExpiry: 'delete',
        purgeMetric: 'privacy_purge_support_chats_total',
        verifyBeforeLaunch: false,
      },
      {
        category: 'raw_webhooks',
        period: { kind: 'months', months: 84 },
        afterExpiry: 'pseudonymize',
        purgeMetric: 'privacy_purge_raw_webhooks_total',
        verifyBeforeLaunch: true,
        note: 'Financial, 7y per spec.',
      },
    ]);
  });
  it('parses valid schedules including each period kind and rejects bad ones with messages', () => {
    expect(parseRetentionSchedule(DEFAULT_RETENTION_SCHEDULE)).toEqual(DEFAULT_RETENTION_SCHEDULE);
    const rule = (over: Record<string, unknown>) => ({
      category: 'kyc',
      period: { kind: 'months', months: 1 },
      afterExpiry: 'delete',
      purgeMetric: 'm',
      verifyBeforeLaunch: false,
      ...over,
    });
    expect(parseRetentionSchedule([rule({})])).toHaveLength(1);
    expect(parseRetentionSchedule([rule({ period: { kind: 'until_deletion' } })])[0]?.period).toEqual({
      kind: 'until_deletion',
    });
    expect(parseRetentionSchedule([rule({ period: { kind: 'after_contract_end_months', months: 3 } })])[0]?.period).toEqual({
      kind: 'after_contract_end_months',
      months: 3,
    });
    expect(() => parseRetentionSchedule([rule({ period: { kind: 'months', months: 0 } })])).toThrow(
      'Invalid retention schedule: ',
    );
    expect(() => parseRetentionSchedule([rule({ period: { kind: 'months', months: 1.5 } })])).toThrow(RetentionError);
    expect(() => parseRetentionSchedule([rule({ period: { kind: 'until_deletion', months: 3 } })])).toThrow(RetentionError);
    expect(() => parseRetentionSchedule([rule({ category: 'nope' })])).toThrow(RetentionError);
    expect(() => parseRetentionSchedule([rule({ purgeMetric: '' })])).toThrow(RetentionError);
    expect(() => parseRetentionSchedule([rule({ extra: 1 })])).toThrow(RetentionError);
    expect(() => parseRetentionSchedule([rule({}), rule({})])).toThrow('Duplicate category kyc');
    expect(() => parseRetentionSchedule('x')).toThrow(RetentionError);
  });
  it('ruleFor finds rules and reports missing ones', () => {
    expect(ruleFor(DEFAULT_RETENTION_SCHEDULE, 'kyc').category).toBe('kyc');
    expect(() => ruleFor([], 'kyc')).toThrow('No retention rule for kyc');
    expect(() => ruleFor([], 'kyc')).toThrow(RetentionError);
  });
  it('retentionExpiry per period kind', () => {
    const base: Omit<RetentionRule, 'period'> = {
      category: 'kyc',
      afterExpiry: 'delete',
      purgeMetric: 'm',
      verifyBeforeLaunch: false,
    };
    const created = '2026-01-31T00:00:00.000Z';
    const ended = '2026-06-15T00:00:00.000Z';
    expect(retentionExpiry({ ...base, period: { kind: 'until_deletion' } }, created)).toBeNull();
    expect(retentionExpiry({ ...base, period: { kind: 'months', months: 1 } }, created)).toBe('2026-02-28T00:00:00.000Z');
    expect(
      retentionExpiry({ ...base, period: { kind: 'after_contract_end_months', months: 60 } }, created, ended),
    ).toBe('2031-06-15T00:00:00.000Z');
    expect(() =>
      retentionExpiry({ ...base, period: { kind: 'after_contract_end_months', months: 60 } }, created),
    ).toThrow('contractEndedAt required');
  });
});
