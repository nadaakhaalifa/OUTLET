import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ANONYMOUS_SESSION,
  DB_ROLES,
  InvalidSessionError,
  assertProcessName,
  sessionSettings,
} from './session-context.js';

const U = '0192f3a4-5b6c-7d8e-9f01-23456789abc1';
const S1 = '0192f3a4-5b6c-7d8e-9f01-23456789abc2';
const S2 = '0192f3a4-5b6c-7d8e-9f01-23456789abc3';

describe('sessionSettings', () => {
  it('anonymous context sets empty values (deny)', () => {
    expect(sessionSettings(ANONYMOUS_SESSION)).toEqual([
      ['app.user_id', ''],
      ['app.role', ''],
      ['app.store_ids', ''],
      ['app.device_id', ''],
    ]);
  });
  it('sorts store ids and joins with commas', () => {
    const m = new Map(sessionSettings({ userId: U, role: 'seller', storeIds: [S2, S1] }));
    expect(m.get('app.store_ids')).toBe(`${S1},${S2}`);
    expect(m.get('app.role')).toBe('seller');
  });
  it('rejects malformed ids, duplicate stores and unknown roles', () => {
    expect(() => sessionSettings({ userId: "x'; --", role: 'customer' })).toThrow(InvalidSessionError);
    expect(() => sessionSettings({ userId: U, role: 'seller', storeIds: [S1, S1] })).toThrow(InvalidSessionError);
    expect(() => sessionSettings({ userId: U, role: 'root' as never })).toThrow(InvalidSessionError);
  });
  it('property: output never contains a value outside uuid/role/commas', () => {
    fc.assert(
      fc.property(fc.uuid(), fc.constantFrom(...DB_ROLES), fc.uniqueArray(fc.uuid(), { maxLength: 5 }), (u, role, stores) => {
        const out = sessionSettings({ userId: u.toLowerCase(), role, storeIds: stores.map((s) => s.toLowerCase()) });
        for (const [, v] of out) expect(v).toMatch(/^[0-9a-z_,-]*$/);
      }),
    );
  });
});

describe('assertProcessName', () => {
  it('accepts dotted lowercase names and rejects the rest', () => {
    expect(assertProcessName('checkout.reserve')).toBe('checkout.reserve');
    for (const bad of ['checkout', 'Checkout.reserve', 'a.b c', `a.${'x'.repeat(70)}`, '']) {
      expect(() => assertProcessName(bad)).toThrow(InvalidSessionError);
    }
  });
});
