import { describe, expect, it } from 'vitest';
import type { AccountOwner } from '../../domain/src/index';
import { ACCOUNT_TYPES } from '../../domain/src/index';
import {
  DOMAIN_ACCOUNT_OWNERS,
  PERSISTED_OWNER_TYPES,
  UnknownLedgerOwnerError,
  parseDomainOwner,
  parsePersistedOwnerType,
  toDomainOwner,
  toPersistedOwnerType,
  type DomainAccountOwner,
  type PersistedOwnerType,
} from './ledger-owner';

// Type-level exhaustiveness: both directions must be mutually assignable.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertTrue = <T extends true>(): T | undefined => undefined;
assertTrue<Equal<DomainAccountOwner, AccountOwner>>();
assertTrue<Equal<ReturnType<typeof toDomainOwner>, AccountOwner>>();

describe('ledger owner mapping', () => {
  it('covers every domain owner kind used by the chart', () => {
    const used = new Set(Object.values(ACCOUNT_TYPES).map((t) => t.owner));
    for (const o of used) expect(DOMAIN_ACCOUNT_OWNERS).toContain(o);
    expect([...DOMAIN_ACCOUNT_OWNERS].sort()).toEqual(
      ['bank', 'bnpl_provider', 'courier', 'platform', 'psp', 'seller', 'shopper'],
    );
  });

  it('maps seller to store and shopper to user, everything else unchanged', () => {
    expect(toPersistedOwnerType('seller')).toBe('store');
    expect(toPersistedOwnerType('shopper')).toBe('user');
    for (const o of DOMAIN_ACCOUNT_OWNERS) {
      if (o !== 'seller' && o !== 'shopper') expect(toPersistedOwnerType(o)).toBe(o);
    }
  });

  it('is a bijection', () => {
    const persisted = DOMAIN_ACCOUNT_OWNERS.map(toPersistedOwnerType);
    expect(new Set(persisted).size).toBe(DOMAIN_ACCOUNT_OWNERS.length);
    for (const o of DOMAIN_ACCOUNT_OWNERS) expect(toDomainOwner(toPersistedOwnerType(o))).toBe(o);
    for (const p of PERSISTED_OWNER_TYPES) expect(toPersistedOwnerType(toDomainOwner(p))).toBe(p);
    expect(DOMAIN_ACCOUNT_OWNERS.length).toBe(PERSISTED_OWNER_TYPES.length);
  });

  it('persisted values are exactly the ledger_accounts owner_type CHECK list (migration 0010)', () => {
    const expected: PersistedOwnerType[] = ['platform', 'store', 'user', 'psp', 'courier', 'bnpl_provider', 'bank'];
    expect([...PERSISTED_OWNER_TYPES].sort()).toEqual([...expected].sort());
  });

  it('parsers accept known values and reject unknown ones, including prototype keys', () => {
    expect(parseDomainOwner('seller')).toBe('seller');
    expect(parsePersistedOwnerType('store')).toBe('store');
    for (const bad of ['store', 'merchant', '', 'toString', '__proto__']) {
      expect(() => parseDomainOwner(bad)).toThrow(UnknownLedgerOwnerError);
    }
    for (const bad of ['seller', 'shopper', '', 'constructor']) {
      expect(() => parsePersistedOwnerType(bad)).toThrow(UnknownLedgerOwnerError);
    }
  });
});
