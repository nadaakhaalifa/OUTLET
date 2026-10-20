import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AuditRedactionError, GENERIC_P3_NAMES_ALLOWED, assertAuditDiff, isP3AuditKey } from './audit-redaction.js';

const INVENTORY = fileURLToPath(new URL('../../../docs/privacy/data_inventory.yaml', import.meta.url));

describe('audit diff redaction', () => {
  it('accepts the diffs the writers actually produce', () => {
    for (const d of [
      { fields: 'phone', reason: 'support' },
      { role: 'finance', user_id: '0192f3a4', approval_id: null, by_requester: false },
      { effect: 'allow', ruleId: 'r1', reason: 'ok', httpStatus: 200, approverIds: ['a', 'b'] },
      { report: 'sales', rowCount: 10, watermark: true, fromMs: 1, toMs: 2 },
      { run_id: 'x', ok: true, report_sha256: 'a'.repeat(64) },
      { kind: 'goodwill', amount_minor: '500' },
    ]) {
      expect(assertAuditDiff(d)).toBe(d);
    }
  });

  it.each(['phone_e164', 'phone', 'dob', 'iban_enc', 'payout_iban_enc', 'national_id_number', 'measurements', 'psp_token_ref', 'street_enc', 'contactPhone', 'email', 'password'])(
    'rejects the P3 key %s',
    (k) => {
      expect(() => assertAuditDiff({ [k]: 'x' })).toThrow(AuditRedactionError);
    },
  );

  it('rejects values that look like personal data, oversized values and nested objects', () => {
    expect(() => assertAuditDiff({ note: 'a@b.eg' })).toThrow(AuditRedactionError);
    expect(() => assertAuditDiff({ note: '+201001234567' })).toThrow(AuditRedactionError);
    expect(() => assertAuditDiff({ note: 'EG380019000500000000263180002' })).toThrow(AuditRedactionError);
    expect(() => assertAuditDiff({ note: 'x'.repeat(257) })).toThrow(AuditRedactionError);
    expect(() => assertAuditDiff({ nested: { phone_e164: '+201001234567' } })).toThrow(AuditRedactionError);
    expect(() => assertAuditDiff({ n: Number.NaN })).toThrow(AuditRedactionError);
  });

  it.each(['date_of_birth', 'birthDate', 'mobile', 'msisdn', 'home_address', 'nid', 'card_number', 'pan', 'lat', 'lng', 'lon'])(
    'rejects the P3 key %s (new tokens)',
    (k) => {
      expect(() => assertAuditDiff({ [k]: 'x' })).toThrow(AuditRedactionError);
    },
  );

  it('rejects long numbers (phones, national IDs as numbers) unless the key ends _minor, _ms or _bps', () => {
    expect(() => assertAuditDiff({ n: 1001234567 })).toThrow(AuditRedactionError);
    expect(() => assertAuditDiff({ n: 29001010123456 })).toThrow(AuditRedactionError);
    expect(() => assertAuditDiff({ n: [1, 12345678] })).toThrow(AuditRedactionError);
    expect(() => assertAuditDiff({ n: -12345678 })).toThrow(AuditRedactionError);
    expect(assertAuditDiff({ n: 1234567, total_minor: 123456789012, atMs: 1760000000000, rate_bps: 99999999 })).toBeTruthy();
  });

  it('rejects EG local phones, national IDs and +E.164 embedded in text, but not hashes', () => {
    expect(() => assertAuditDiff({ note: 'call 01001234567 now' })).toThrow(AuditRedactionError);
    expect(() => assertAuditDiff({ note: '01501234567' })).toThrow(AuditRedactionError);
    expect(() => assertAuditDiff({ note: 'nid 29001010123456.' })).toThrow(AuditRedactionError);
    expect(() => assertAuditDiff({ note: 'reach me at +201001234567 please' })).toThrow(AuditRedactionError);
    expect(assertAuditDiff({ h: 'a'.repeat(20) + '12345678901234' + 'b'.repeat(20), v: 'order 12345' })).toBeTruthy();
  });

  it('applies the value rules to array elements', () => {
    expect(() => assertAuditDiff({ list: ['ok', '01001234567'] })).toThrow(AuditRedactionError);
    expect(() => assertAuditDiff({ list: ['a@b.eg'] })).toThrow(AuditRedactionError);
  });

  it('scans JSON embedded in strings, keys and values, including nesting', () => {
    expect(() => assertAuditDiff({ blob: '{"phone":"x"}' })).toThrow(AuditRedactionError);
    expect(() => assertAuditDiff({ blob: '{"a":{"note":"01001234567"}}' })).toThrow(AuditRedactionError);
    expect(() => assertAuditDiff({ blob: '["+201001234567"]' })).toThrow(AuditRedactionError);
    expect(() => assertAuditDiff({ blob: '{"n":12345678}' })).toThrow(AuditRedactionError);
    expect(assertAuditDiff({ blob: '{"a":1,"b":["x"]}', other: '{not json' })).toBeTruthy();
  });

  it('never echoes the offending value in the error', () => {
    try {
      assertAuditDiff({ note: '+201001234567' });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('201001234567');
    }
  });

  it('classifies every P3 column in data_inventory.yaml: denied by name or explicitly listed as generic', () => {
    const names = new Set<string>();
    for (const line of readFileSync(INVENTORY, 'utf8').split('\n')) {
      const m = /\{name: ([a-z0-9_]+), pii_class: P3\b/.exec(line);
      if (m?.[1] !== undefined) names.add(m[1]);
    }
    expect(names.size).toBeGreaterThan(20);
    const unclassified = [...names].filter((n) => !isP3AuditKey(n) && !GENERIC_P3_NAMES_ALLOWED.has(n));
    expect(unclassified).toEqual([]);
    // Every generic exemption must still exist in the inventory (no stale allowances).
    for (const g of GENERIC_P3_NAMES_ALLOWED) expect(names.has(g), g).toBe(true);
  });
});
