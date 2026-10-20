import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DSAR_STATES, DSAR_TYPES, canTransition, createDsar, daysRemaining, isOverdue, transitionDsar,
} from './dsar.js';
import {
  beginErasure, cancelDeletion, completeErasure, evaluateDeletionEligibility, pseudonymFor,
  requestDeletion, treatmentFor, type DeletionSnapshot,
} from './deletion.js';
import { fakeHasher, fixedClock } from './fixtures.js';

const t0 = fixedClock('2026-10-10T00:00:00.000Z');

describe('DSAR', () => {
  it('defaults to a 30 day SLA and is configurable', () => {
    const r = createDsar({ id: 'd1', userId: 'u', type: 'export' }, t0);
    expect(r.dueAt).toBe('2026-11-09T00:00:00.000Z');
    expect(r.exportTargetAt).toBe('2026-10-13T00:00:00.000Z');
    expect(createDsar({ id: 'd2', userId: 'u', type: 'delete' }, t0, { slaDays: 10 }).dueAt).toBe('2026-10-20T00:00:00.000Z');
    expect(createDsar({ id: 'd2', userId: 'u', type: 'rectify' }, t0).exportTargetAt).toBeUndefined();
    expect(() => createDsar({ id: 'd', userId: 'u', type: 'export' }, t0, { slaDays: 0 })).toThrow();
  });
  it('walks the happy path and refuses illegal moves', () => {
    let r = createDsar({ id: 'd', userId: 'u', type: 'rectify' }, t0);
    r = transitionDsar(r, 'verifying_identity', t0);
    r = transitionDsar(r, 'in_progress', t0);
    r = transitionDsar(r, 'completed', t0);
    expect(() => transitionDsar(r, 'in_progress', t0)).toThrow();
    const fresh = createDsar({ id: 'd', userId: 'u', type: 'rectify' }, t0);
    expect(() => transitionDsar(fresh, 'completed', t0)).toThrow();
    expect(() => transitionDsar(fresh, 'rejected', t0)).toThrow(/reason/);
    expect(transitionDsar(fresh, 'rejected', t0, { rejectionReason: 'identity_unverified' }).state).toBe('rejected');
  });
  it('overdue only while open', () => {
    const r = createDsar({ id: 'd', userId: 'u', type: 'export' }, t0);
    const late = fixedClock('2026-11-10T00:00:00.000Z');
    expect(isOverdue(r, t0)).toBe(false);
    expect(isOverdue(r, late)).toBe(true);
    expect(daysRemaining(r, late)).toBe(-1);
    expect(isOverdue({ ...r, state: 'completed' }, late)).toBe(false);
  });
  it('property: terminal states have no exits', () => {
    fc.assert(fc.property(fc.constantFrom('completed', 'rejected', 'cancelled' as const), fc.constantFrom(...DSAR_STATES), (a, b) => !canTransition(a, b)));
    expect(DSAR_TYPES).toEqual(['export', 'delete', 'rectify']);
  });
});

const clean: DeletionSnapshot = { openOrders: 0, openReturns: 0, openDisputes: 0, storeCreditMinor: 0n };

describe('account deletion', () => {
  it('is blocked while orders, returns or disputes are open and says why', () => {
    expect(evaluateDeletionEligibility({ ...clean, openOrders: 2, openDisputes: 1 })).toEqual({
      eligible: false,
      blockers: [{ kind: 'open_orders', count: 2 }, { kind: 'open_disputes', count: 1 }],
    });
    expect(() => requestDeletion({ id: 'x', userId: 'u', acknowledgedForfeiture: true }, { ...clean, openReturns: 1 }, t0)).toThrow(/blocked/);
  });
  it('warns on store credit and requires acknowledgement', () => {
    const snap = { ...clean, storeCreditMinor: 15_000n };
    expect(evaluateDeletionEligibility(snap)).toEqual({ eligible: true, forfeitureWarning: { balanceMinor: 15_000n } });
    expect(() => requestDeletion({ id: 'x', userId: 'u', acknowledgedForfeiture: false }, snap, t0)).toThrow(/forfeiture/);
    const r = requestDeletion({ id: 'x', userId: 'u', acknowledgedForfeiture: true }, snap, t0);
    expect(r.forfeitedStoreCreditMinor).toBe(15_000n);
  });
  it('has a 14 day cooling period, cancellable only within it', () => {
    const r = requestDeletion({ id: 'x', userId: 'u', acknowledgedForfeiture: false }, clean, t0);
    expect(r.coolingEndsAt).toBe('2026-10-24T00:00:00.000Z');
    expect(() => beginErasure(r, clean, fixedClock('2026-10-23T23:59:59.000Z'))).toThrow(/Cooling/);
    expect(cancelDeletion(r, fixedClock('2026-10-20T00:00:00.000Z')).status).toBe('cancelled');
    expect(() => cancelDeletion(r, fixedClock('2026-10-24T00:00:00.000Z'))).toThrow();
  });
  it('re-checks blockers at erasure time', () => {
    const r = requestDeletion({ id: 'x', userId: 'u', acknowledgedForfeiture: false }, clean, t0);
    const after = fixedClock('2026-10-25T00:00:00.000Z');
    expect(() => beginErasure(r, { ...clean, openOrders: 1 }, after)).toThrow(/blocked/);
    const done = completeErasure(beginErasure(r, clean, after), after);
    expect(done.status).toBe('completed');
    expect(() => cancelDeletion(done, after)).toThrow();
  });
  it('keeps financial records pseudonymized and erases the rest', () => {
    expect(treatmentFor('orders_and_invoices')).toBe('pseudonymize_retain_legal');
    expect(treatmentFor('ledger_entries')).toBe('pseudonymize_retain_legal');
    expect(treatmentFor('addresses')).toBe('erase');
    expect(treatmentFor('something_new')).toBe('erase');
    const p = pseudonymFor('user-123', fakeHasher);
    expect(p).toBe(pseudonymFor('user-123', fakeHasher));
    expect(p).not.toContain('user-123');
  });
});
