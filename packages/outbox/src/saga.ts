/**
 * Saga orchestration as pure types and a pure reducer (spec A2.8, microservices.io
 * saga pattern). No I/O: an orchestrator adapter executes the commands this
 * module emits, persists the state, and feeds results back as events.
 *
 * Step kinds follow the standard taxonomy:
 *  - compensatable: can be undone by a compensating command.
 *  - pivot: the go/no-go point (at most one). Once it succeeds the saga can
 *    no longer roll back; it can only move forward.
 *  - retriable: after the pivot; retried until it succeeds, never compensated.
 */
import { InvalidSagaDefinitionError, InvalidSagaTransitionError } from './errors.js';

export type StepKind = 'compensatable' | 'pivot' | 'retriable';

export interface SagaStep {
  readonly name: string;
  readonly kind: StepKind;
  /** Command name sent to the owning module. */
  readonly command: string;
  /** Command that undoes `command`; required for compensatable, forbidden otherwise. */
  readonly compensation: string | null;
}

export interface SagaDefinition {
  readonly name: string;
  readonly steps: readonly SagaStep[];
}

export type SagaStatus = 'running' | 'compensating' | 'completed' | 'compensated' | 'stuck';

export interface SagaState {
  readonly sagaId: string;
  readonly definition: string;
  readonly status: SagaStatus;
  /** Steps whose effect exists, in execution order. */
  readonly completedSteps: readonly string[];
  readonly compensatedSteps: readonly string[];
  readonly failedStep: string | null;
  readonly failureReason: string | null;
  /** Set when status is 'stuck': needs a human or the reconciliation job. */
  readonly stuckReason: string | null;
}

export type SagaEvent =
  | { readonly type: 'step_succeeded'; readonly step: string }
  | { readonly type: 'step_failed'; readonly step: string; readonly reason: string; readonly retryable: boolean }
  | { readonly type: 'compensation_succeeded'; readonly step: string }
  | { readonly type: 'compensation_failed'; readonly step: string; readonly reason: string; readonly retryable: boolean };

export type SagaCommand =
  | { readonly kind: 'execute'; readonly step: string; readonly command: string }
  | { readonly kind: 'compensate'; readonly step: string; readonly command: string };

export function defineSaga(def: SagaDefinition): SagaDefinition {
  if (def.steps.length === 0) throw new InvalidSagaDefinitionError(`${def.name}: no steps`);
  const names = new Set<string>();
  let pivots = 0;
  let sawNonCompensatable = false;
  for (const s of def.steps) {
    if (names.has(s.name)) throw new InvalidSagaDefinitionError(`${def.name}: duplicate step ${s.name}`);
    names.add(s.name);
    if (s.kind === 'compensatable') {
      if (s.compensation === null) throw new InvalidSagaDefinitionError(`${s.name}: compensatable step needs a compensation`);
      if (sawNonCompensatable) {
        throw new InvalidSagaDefinitionError(`${s.name}: compensatable step after pivot or retriable step`);
      }
    } else {
      if (s.compensation !== null) throw new InvalidSagaDefinitionError(`${s.name}: ${s.kind} step must not have a compensation`);
      sawNonCompensatable = true;
      if (s.kind === 'pivot') pivots += 1;
      if (s.kind === 'retriable' && pivots === 0 && def.steps.some((x) => x.kind === 'pivot')) {
        throw new InvalidSagaDefinitionError(`${s.name}: retriable step before pivot`);
      }
      if (s.kind === 'pivot' && def.steps.slice(0, def.steps.indexOf(s)).some((x) => x.kind === 'retriable')) {
        throw new InvalidSagaDefinitionError(`${s.name}: pivot after retriable step`);
      }
    }
  }
  if (pivots > 1) throw new InvalidSagaDefinitionError(`${def.name}: more than one pivot`);
  return def;
}

export function startSaga(def: SagaDefinition, sagaId: string): SagaState {
  return {
    sagaId,
    definition: def.name,
    status: 'running',
    completedSteps: [],
    compensatedSteps: [],
    failedStep: null,
    failureReason: null,
    stuckReason: null,
  };
}

function stepOf(def: SagaDefinition, name: string): SagaStep {
  const s = def.steps.find((x) => x.name === name);
  if (s === undefined) throw new InvalidSagaTransitionError(`${def.name}: unknown step ${name}`);
  return s;
}

function pivotDone(def: SagaDefinition, st: SagaState): boolean {
  return st.completedSteps.some((n) => stepOf(def, n).kind === 'pivot');
}

function pendingCompensations(def: SagaDefinition, st: SagaState): readonly string[] {
  return st.completedSteps
    .filter((n) => stepOf(def, n).kind === 'compensatable' && !st.compensatedSteps.includes(n))
    .reverse();
}

function beginCompensation(def: SagaDefinition, st: SagaState, step: string, reason: string): SagaState {
  const next: SagaState = { ...st, status: 'compensating', failedStep: step, failureReason: reason };
  return pendingCompensations(def, next).length === 0 ? { ...next, status: 'compensated' } : next;
}

function stuck(st: SagaState, reason: string): SagaState {
  return { ...st, status: 'stuck', stuckReason: reason };
}

/** What to do next, or null when the saga is finished, stuck, or waiting on a retry. */
export function nextCommand(def: SagaDefinition, st: SagaState): SagaCommand | null {
  if (st.status === 'running') {
    const step = def.steps.find((s) => !st.completedSteps.includes(s.name));
    return step === undefined ? null : { kind: 'execute', step: step.name, command: step.command };
  }
  if (st.status === 'compensating') {
    const name = pendingCompensations(def, st)[0];
    if (name === undefined) return null;
    const comp = stepOf(def, name).compensation;
    return comp === null ? null : { kind: 'compensate', step: name, command: comp };
  }
  return null;
}

/**
 * Pure transition. Events arrive at-least-once, so repeats of an already
 * applied event are no-ops rather than errors.
 */
export function applyEvent(def: SagaDefinition, st: SagaState, ev: SagaEvent): SagaState {
  const step = stepOf(def, ev.step);
  switch (ev.type) {
    case 'step_succeeded': {
      if (st.completedSteps.includes(ev.step)) return st;
      if (st.status === 'running') {
        const expected = def.steps.find((s) => !st.completedSteps.includes(s.name));
        if (expected?.name !== ev.step) {
          throw new InvalidSagaTransitionError(`${def.name}: ${ev.step} succeeded out of order`);
        }
        const completedSteps = [...st.completedSteps, ev.step];
        const done = completedSteps.length === def.steps.length;
        return { ...st, completedSteps, status: done ? 'completed' : 'running' };
      }
      if (st.status === 'compensating' && st.failedStep === ev.step) {
        // Late success of a step already treated as failed (for example a timeout).
        // Its effect now exists, so it must be compensated too.
        if (step.kind === 'compensatable') {
          return { ...st, completedSteps: [...st.completedSteps, ev.step] };
        }
        return stuck(
          { ...st, completedSteps: [...st.completedSteps, ev.step] },
          `${ev.step} completed after compensation began and cannot be undone by this saga`,
        );
      }
      throw new InvalidSagaTransitionError(`${def.name}: step_succeeded ${ev.step} in status ${st.status}`);
    }
    case 'step_failed': {
      if (st.status !== 'running') {
        if (st.failedStep === ev.step || st.completedSteps.includes(ev.step)) return st;
        throw new InvalidSagaTransitionError(`${def.name}: step_failed ${ev.step} in status ${st.status}`);
      }
      if (ev.retryable) return st; // orchestrator re-issues the same command
      if (pivotDone(def, st) || step.kind === 'retriable') {
        return stuck(
          { ...st, failedStep: ev.step, failureReason: ev.reason },
          `${ev.step} failed permanently after the pivot; forward recovery or manual action required`,
        );
      }
      return beginCompensation(def, st, ev.step, ev.reason);
    }
    case 'compensation_succeeded': {
      if (st.compensatedSteps.includes(ev.step)) return st;
      if (st.status !== 'compensating' || !st.completedSteps.includes(ev.step)) {
        throw new InvalidSagaTransitionError(`${def.name}: compensation_succeeded ${ev.step} not expected`);
      }
      const next: SagaState = { ...st, compensatedSteps: [...st.compensatedSteps, ev.step] };
      return pendingCompensations(def, next).length === 0 ? { ...next, status: 'compensated' } : next;
    }
    case 'compensation_failed': {
      if (st.status !== 'compensating') return st;
      if (ev.retryable) return st;
      return stuck(st, `compensation of ${ev.step} failed permanently: ${ev.reason}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Concrete definitions. Command names are contracts with the owning modules.
// Provider-specific behaviour (PSP void vs refund, payout rails) is VERIFY
// BEFORE LAUNCH: see README.
// ---------------------------------------------------------------------------

/** Online-payment checkout (master prompt section on checkout saga, steps 1-7). */
export const CHECKOUT_SAGA = defineSaga({
  name: 'checkout',
  steps: [
    { name: 'validate_cart', kind: 'compensatable', command: 'checkout.validate_cart', compensation: 'checkout.noop' },
    { name: 'reserve_inventory', kind: 'compensatable', command: 'inventory.reserve', compensation: 'inventory.release_reservation' },
    { name: 'apply_credit', kind: 'compensatable', command: 'ledger.hold_credit', compensation: 'ledger.release_credit_hold' },
    { name: 'create_payment_intent', kind: 'compensatable', command: 'payments.create_intent', compensation: 'payments.void_intent' },
    // Pivot: the PSP confirmed payment (HMAC-verified webhook). Cannot be rolled back, only refunded via the refund saga.
    { name: 'confirm_payment', kind: 'pivot', command: 'payments.await_confirmation', compensation: null },
    { name: 'claim_inventory', kind: 'retriable', command: 'inventory.claim', compensation: null },
    { name: 'post_ledger', kind: 'retriable', command: 'ledger.post_sale', compensation: null },
    { name: 'emit_order_group_paid', kind: 'retriable', command: 'orders.mark_paid', compensation: null },
  ],
});

/** Cash on delivery: skips payment steps; claimed immediately after the risk check. */
export const CHECKOUT_COD_SAGA = defineSaga({
  name: 'checkout_cod',
  steps: [
    { name: 'validate_cart', kind: 'compensatable', command: 'checkout.validate_cart', compensation: 'checkout.noop' },
    { name: 'reserve_inventory', kind: 'compensatable', command: 'inventory.reserve', compensation: 'inventory.release_reservation' },
    { name: 'apply_credit', kind: 'compensatable', command: 'ledger.hold_credit', compensation: 'ledger.release_credit_hold' },
    { name: 'risk_check_and_confirm', kind: 'pivot', command: 'risk.check_and_confirm_cod', compensation: null },
    { name: 'claim_inventory', kind: 'retriable', command: 'inventory.claim', compensation: null },
    { name: 'post_ledger', kind: 'retriable', command: 'ledger.post_cod_sale', compensation: null },
    { name: 'emit_order_group_confirmed', kind: 'retriable', command: 'orders.mark_confirmed_cod', compensation: null },
  ],
});

/** Refund: reverse entries are posted before money moves; the PSP refund is the pivot. */
export const REFUND_SAGA = defineSaga({
  name: 'refund',
  steps: [
    { name: 'validate_refund', kind: 'compensatable', command: 'refunds.validate', compensation: 'refunds.noop' },
    { name: 'post_refund_ledger', kind: 'compensatable', command: 'ledger.post_refund', compensation: 'ledger.reverse_entry' },
    { name: 'request_psp_refund', kind: 'pivot', command: 'payments.refund', compensation: null },
    { name: 'restore_credit_or_stock', kind: 'retriable', command: 'refunds.finalize_side_effects', compensation: null },
    { name: 'notify_shopper', kind: 'retriable', command: 'notifications.refund_issued', compensation: null },
  ],
});

/** Seller payout: funds are frozen and ledgered before the transfer is initiated (pivot). */
export const PAYOUT_SAGA = defineSaga({
  name: 'payout',
  steps: [
    { name: 'freeze_eligible_balance', kind: 'compensatable', command: 'payouts.freeze_balance', compensation: 'payouts.unfreeze_balance' },
    { name: 'post_payout_ledger', kind: 'compensatable', command: 'ledger.post_payout', compensation: 'ledger.reverse_entry' },
    { name: 'initiate_transfer', kind: 'pivot', command: 'payouts.initiate_transfer', compensation: null },
    { name: 'record_settlement', kind: 'retriable', command: 'payouts.record_settlement', compensation: null },
    { name: 'notify_seller', kind: 'retriable', command: 'notifications.payout_sent', compensation: null },
  ],
});

/**
 * Cancellation cascade (free before SHIPPED). The refund is the pivot because
 * once the PSP refund or void is accepted the cancellation cannot be undone.
 * Money movement itself is delegated to REFUND_SAGA by `start_refund`.
 */
export const CANCELLATION_SAGA = defineSaga({
  name: 'cancellation',
  steps: [
    { name: 'mark_cancel_requested', kind: 'compensatable', command: 'orders.mark_cancel_requested', compensation: 'orders.clear_cancel_requested' },
    { name: 'release_or_restock_inventory', kind: 'compensatable', command: 'inventory.release_or_restock', compensation: 'inventory.re_reserve' },
    { name: 'reverse_commission_ledger', kind: 'compensatable', command: 'ledger.reverse_commission', compensation: 'ledger.reinstate_commission' },
    { name: 'start_refund', kind: 'pivot', command: 'refunds.start_refund_saga', compensation: null },
    { name: 'mark_cancelled', kind: 'retriable', command: 'orders.mark_cancelled', compensation: null },
    { name: 'notify_seller_and_shopper', kind: 'retriable', command: 'notifications.order_cancelled', compensation: null },
  ],
});
