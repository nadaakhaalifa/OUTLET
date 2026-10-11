import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CONSENT_PURPOSES, consentStatus, consentView, defaultConsentView, grantConsent, mayInitialise,
  withdrawConsent, GATED_PROCESSING, PROCESSING_REQUIREMENTS, ConsentRecordSchema,
  type ConsentHistory, type ConsentInput, type ConsentPurpose,
} from './consent.js';
import { fakeHasher, fixedClock } from './fixtures.js';

const ip = fakeHasher('1.2.3.4');
const versions = Object.fromEntries(CONSENT_PURPOSES.map((p) => [p, 2])) as Record<ConsentPurpose, number>;
const input = (purpose: ConsentPurpose, version = 2): ConsentInput => ({
  userId: 'u1', purpose, version, method: 'settings_toggle', ipHash: ip,
});

describe('consent', () => {
  it('has the nine B1 purposes', () => {
    expect(CONSENT_PURPOSES).toHaveLength(9);
  });
  it('is never pre-ticked', () => {
    expect(Object.values(defaultConsentView()).every((v) => v === false)).toBe(true);
    expect(Object.values(consentView([], 'u1', versions)).every((v) => v === false)).toBe(true);
    for (const item of GATED_PROCESSING) expect(mayInitialise(item, [], 'u1', versions).allowed).toBe(false);
  });
  it('rejects a non-explicit method', () => {
    expect(ConsentRecordSchema.safeParse({
      userId: 'u', purpose: 'analytics', version: 1, granted: true, method: 'default',
      at: '2026-10-10T00:00:00.000Z', ipHash: ip,
    }).success).toBe(false);
  });
  it('grant then withdraw, append-only', () => {
    const c1 = fixedClock('2026-10-10T10:00:00.000Z');
    const c2 = fixedClock('2026-10-11T10:00:00.000Z');
    const h1 = grantConsent([], input('analytics'), c1);
    expect(mayInitialise('posthog', h1, 'u1', versions).allowed).toBe(true);
    const h2 = withdrawConsent(h1, input('analytics'), c2);
    expect(h2).toHaveLength(2);
    expect(h1).toHaveLength(1);
    expect(consentStatus(h2, 'u1', 'analytics', 2)).toBe('withdrawn');
    expect(mayInitialise('posthog', h2, 'u1', versions).allowed).toBe(false);
  });
  it('requires re-consent after a version bump', () => {
    const h = grantConsent([], input('analytics', 1), fixedClock('2026-10-10T10:00:00.000Z'));
    expect(consentStatus(h, 'u1', 'analytics', 2)).toBe('reconsent_required');
    expect(mayInitialise('posthog', h, 'u1', versions)).toMatchObject({ allowed: false });
  });
  it('does not leak between users or purposes', () => {
    const h = grantConsent([], input('marketing_push'), fixedClock('2026-10-10T10:00:00.000Z'));
    expect(consentStatus(h, 'u2', 'marketing_push', 2)).toBe('never_asked');
    expect(consentStatus(h, 'u1', 'marketing_email', 2)).toBe('never_asked');
  });
  it('ads sdk needs both purposes', () => {
    const c = fixedClock('2026-10-10T10:00:00.000Z');
    const h = grantConsent([], input('analytics'), c);
    expect(mayInitialise('ads_sdk', h, 'u1', versions)).toMatchObject({
      allowed: false, missing: [{ purpose: 'personalization', status: 'never_asked' }],
    });
  });
  it('property: SDK may initialise iff every required purpose is currently granted', () => {
    const op = fc.record({
      purpose: fc.constantFrom(...CONSENT_PURPOSES),
      grant: fc.boolean(),
    });
    fc.assert(fc.property(fc.array(op, { maxLength: 30 }), fc.constantFrom(...GATED_PROCESSING), (ops, item) => {
      let h: ConsentHistory = [];
      const state = new Map<ConsentPurpose, boolean>();
      ops.forEach((o, i) => {
        const clock = fixedClock(new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString());
        h = o.grant ? grantConsent(h, input(o.purpose), clock) : withdrawConsent(h, input(o.purpose), clock);
        state.set(o.purpose, o.grant);
      });
      const expected = PROCESSING_REQUIREMENTS[item].every((p) => state.get(p) === true);
      return mayInitialise(item, h, 'u1', versions).allowed === expected;
    }));
  });
});
