import { describe, expect, it } from 'vitest';

// Modules build schemas and tables at import time. Importing them dynamically inside a test makes a
// mutant that breaks module initialisation fail a test instead of silently failing the whole file.
describe('modules load', () => {
  it('initialise and expose their tables', async () => {
    const consent = await import('./consent.js');
    const age = await import('./age-policy.js');
    const dsar = await import('./dsar.js');
    const del = await import('./deletion.js');
    const ret = await import('./retention.js');
    const ports = await import('./ports.js');
    expect(consent.CONSENT_PURPOSES).toHaveLength(9);
    expect(age.DEFAULT_AGE_POLICY.account_create).toBe(18);
    expect(dsar.DSAR_STATES).toHaveLength(6);
    expect(del.ERASURE_PLAN['kyc']).toBe('pseudonymize_retain_legal');
    expect(ret.DEFAULT_RETENTION_SCHEDULE).toHaveLength(6);
    expect(ports.HEX_HASH.test('a'.repeat(16))).toBe(true);
  });
});
