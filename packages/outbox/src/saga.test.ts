import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { InvalidSagaDefinitionError, InvalidSagaTransitionError } from './errors.js';
import {
  CANCELLATION_SAGA,
  CHECKOUT_COD_SAGA,
  CHECKOUT_SAGA,
  PAYOUT_SAGA,
  REFUND_SAGA,
  applyEvent,
  defineSaga,
  nextCommand,
  startSaga,
  type SagaDefinition,
  type SagaState,
} from './saga.js';

const ALL = [CHECKOUT_SAGA, CHECKOUT_COD_SAGA, REFUND_SAGA, PAYOUT_SAGA, CANCELLATION_SAGA];

/** Drives a saga; `failAt` makes that step fail permanently. Returns state and executed commands. */
function drive(def: SagaDefinition, failAt: string | null) {
  let st: SagaState = startSaga(def, 's1');
  const log: string[] = [];
  for (let i = 0; i < 100; i += 1) {
    const cmd = nextCommand(def, st);
    if (cmd === null) break;
    log.push(`${cmd.kind}:${cmd.step}`);
    if (cmd.kind === 'execute') {
      st = applyEvent(def, st, cmd.step === failAt
        ? { type: 'step_failed', step: cmd.step, reason: 'x', retryable: false }
        : { type: 'step_succeeded', step: cmd.step });
    } else {
      st = applyEvent(def, st, { type: 'compensation_succeeded', step: cmd.step });
    }
  }
  return { st, log };
}

describe('saga definitions', () => {
  it('all shipped definitions are valid and complete on the happy path', () => {
    for (const d of ALL) expect(drive(d, null).st.status).toBe('completed');
  });
  it('rejects invalid shapes', () => {
    const c = (name: string, comp: string | null) => ({ name, kind: 'compensatable' as const, command: name, compensation: comp });
    expect(() => defineSaga({ name: 'x', steps: [c('a', null)] })).toThrow(InvalidSagaDefinitionError);
    expect(() => defineSaga({ name: 'x', steps: [c('a', 'u'), c('a', 'u')] })).toThrow(InvalidSagaDefinitionError);
    expect(() =>
      defineSaga({ name: 'x', steps: [{ name: 'p', kind: 'pivot', command: 'p', compensation: null }, c('a', 'u')] }),
    ).toThrow(InvalidSagaDefinitionError);
  });
});

describe('compensation', () => {
  it('property: failing any pre-pivot step compensates exactly the completed compensatable steps in reverse', () => {
    for (const def of ALL) {
      const pivotIdx = def.steps.findIndex((s) => s.kind === 'pivot');
      fc.assert(
        fc.property(fc.integer({ min: 0, max: pivotIdx }), (i) => {
          const failAt = def.steps[i]?.name ?? '';
          const { st, log } = drive(def, failAt);
          expect(st.status).toBe('compensated');
          const executed = def.steps.slice(0, i).map((s) => s.name);
          const comps = log.filter((l) => l.startsWith('compensate:')).map((l) => l.slice('compensate:'.length));
          expect(comps).toEqual([...executed].reverse());
          expect(log.filter((l) => l.startsWith('execute:')).length).toBe(i + 1);
        }),
      );
    }
  });

  it('checkout failure after reservation releases reservation and voids the intent in reverse order', () => {
    const { st, log } = drive(CHECKOUT_SAGA, 'create_payment_intent');
    expect(st.status).toBe('compensated');
    expect(log.filter((l) => l.startsWith('compensate:'))).toEqual([
      'compensate:apply_credit',
      'compensate:reserve_inventory',
      'compensate:validate_cart',
    ]);
  });

  it('failure after the pivot is never compensated: it becomes stuck', () => {
    const { st, log } = drive(CHECKOUT_SAGA, 'post_ledger');
    expect(st.status).toBe('stuck');
    expect(log.some((l) => l.startsWith('compensate:'))).toBe(false);
    expect(st.stuckReason).toContain('post_ledger');
  });

  it('retryable failure keeps the same next command', () => {
    let st = startSaga(CHECKOUT_SAGA, 's');
    st = applyEvent(CHECKOUT_SAGA, st, { type: 'step_succeeded', step: 'validate_cart' });
    const before = nextCommand(CHECKOUT_SAGA, st);
    st = applyEvent(CHECKOUT_SAGA, st, { type: 'step_failed', step: 'reserve_inventory', reason: 'timeout', retryable: true });
    expect(nextCommand(CHECKOUT_SAGA, st)).toEqual(before);
  });

  it('late success of a timed-out step is also compensated', () => {
    const def = CHECKOUT_SAGA;
    let st = startSaga(def, 's');
    for (const s of ['validate_cart', 'reserve_inventory', 'apply_credit']) {
      st = applyEvent(def, st, { type: 'step_succeeded', step: s });
    }
    st = applyEvent(def, st, { type: 'step_failed', step: 'create_payment_intent', reason: 'timeout', retryable: false });
    expect(st.status).toBe('compensating');
    st = applyEvent(def, st, { type: 'step_succeeded', step: 'create_payment_intent' });
    expect(nextCommand(def, st)).toMatchObject({ kind: 'compensate', step: 'create_payment_intent' });
  });

  it('late success of the pivot during compensation is escalated, not silently ignored', () => {
    const def = CHECKOUT_SAGA;
    let st = startSaga(def, 's');
    for (const s of ['validate_cart', 'reserve_inventory', 'apply_credit', 'create_payment_intent']) {
      st = applyEvent(def, st, { type: 'step_succeeded', step: s });
    }
    st = applyEvent(def, st, { type: 'step_failed', step: 'confirm_payment', reason: 'timeout', retryable: false });
    st = applyEvent(def, st, { type: 'step_succeeded', step: 'confirm_payment' });
    expect(st.status).toBe('stuck');
  });

  it('permanent compensation failure is stuck, retryable one is not', () => {
    const def = CHECKOUT_SAGA;
    let st = startSaga(def, 's');
    st = applyEvent(def, st, { type: 'step_succeeded', step: 'validate_cart' });
    st = applyEvent(def, st, { type: 'step_failed', step: 'reserve_inventory', reason: 'oos', retryable: false });
    const same = applyEvent(def, st, { type: 'compensation_failed', step: 'validate_cart', reason: 't', retryable: true });
    expect(same.status).toBe('compensating');
    expect(applyEvent(def, st, { type: 'compensation_failed', step: 'validate_cart', reason: 'x', retryable: false }).status).toBe('stuck');
  });
});

describe('at-least-once events', () => {
  it('duplicate step_succeeded is a no-op and out-of-order is rejected', () => {
    const def = REFUND_SAGA;
    let st = startSaga(def, 's');
    st = applyEvent(def, st, { type: 'step_succeeded', step: 'validate_refund' });
    expect(applyEvent(def, st, { type: 'step_succeeded', step: 'validate_refund' })).toEqual(st);
    expect(() => applyEvent(def, st, { type: 'step_succeeded', step: 'request_psp_refund' })).toThrow(
      InvalidSagaTransitionError,
    );
  });
});
