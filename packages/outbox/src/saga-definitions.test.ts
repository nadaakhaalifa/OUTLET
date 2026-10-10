import { describe, expect, it } from 'vitest';
import type { SagaDefinition, SagaStep } from './saga.js';

// The saga module builds its definitions at import time. These tests import it dynamically so that a
// mutant which breaks module initialisation fails a test instead of failing the whole file silently.
type Row = readonly [string, SagaStep['kind'], string, string | null];
const rows = (d: SagaDefinition): Row[] => d.steps.map((s) => [s.name, s.kind, s.command, s.compensation]);
const load = () => import('./saga.js');

describe('shipped saga definitions are exactly as specified', () => {
  it('checkout', async () => {
    const { CHECKOUT_SAGA } = await load();
    expect(CHECKOUT_SAGA.name).toBe('checkout');
    expect(rows(CHECKOUT_SAGA)).toEqual([
      ['validate_cart', 'compensatable', 'checkout.validate_cart', 'checkout.noop'],
      ['reserve_inventory', 'compensatable', 'inventory.reserve', 'inventory.release_reservation'],
      ['apply_credit', 'compensatable', 'ledger.hold_credit', 'ledger.release_credit_hold'],
      ['create_payment_intent', 'compensatable', 'payments.create_intent', 'payments.void_intent'],
      ['confirm_payment', 'pivot', 'payments.await_confirmation', null],
      ['claim_inventory', 'retriable', 'inventory.claim', null],
      ['post_ledger', 'retriable', 'ledger.post_sale', null],
      ['emit_order_group_paid', 'retriable', 'orders.mark_paid', null],
    ]);
  });
  it('checkout_cod', async () => {
    const { CHECKOUT_COD_SAGA } = await load();
    expect(CHECKOUT_COD_SAGA.name).toBe('checkout_cod');
    expect(rows(CHECKOUT_COD_SAGA)).toEqual([
      ['validate_cart', 'compensatable', 'checkout.validate_cart', 'checkout.noop'],
      ['reserve_inventory', 'compensatable', 'inventory.reserve', 'inventory.release_reservation'],
      ['apply_credit', 'compensatable', 'ledger.hold_credit', 'ledger.release_credit_hold'],
      ['risk_check_and_confirm', 'pivot', 'risk.check_and_confirm_cod', null],
      ['claim_inventory', 'retriable', 'inventory.claim', null],
      ['post_ledger', 'retriable', 'ledger.post_cod_sale', null],
      ['emit_order_group_confirmed', 'retriable', 'orders.mark_confirmed_cod', null],
    ]);
  });
  it('refund', async () => {
    const { REFUND_SAGA } = await load();
    expect(REFUND_SAGA.name).toBe('refund');
    expect(rows(REFUND_SAGA)).toEqual([
      ['validate_refund', 'compensatable', 'refunds.validate', 'refunds.noop'],
      ['post_refund_ledger', 'compensatable', 'ledger.post_refund', 'ledger.reverse_entry'],
      ['request_psp_refund', 'pivot', 'payments.refund', null],
      ['restore_credit_or_stock', 'retriable', 'refunds.finalize_side_effects', null],
      ['notify_shopper', 'retriable', 'notifications.refund_issued', null],
    ]);
  });
  it('payout', async () => {
    const { PAYOUT_SAGA } = await load();
    expect(PAYOUT_SAGA.name).toBe('payout');
    expect(rows(PAYOUT_SAGA)).toEqual([
      ['freeze_eligible_balance', 'compensatable', 'payouts.freeze_balance', 'payouts.unfreeze_balance'],
      ['post_payout_ledger', 'compensatable', 'ledger.post_payout', 'ledger.reverse_entry'],
      ['initiate_transfer', 'pivot', 'payouts.initiate_transfer', null],
      ['record_settlement', 'retriable', 'payouts.record_settlement', null],
      ['notify_seller', 'retriable', 'notifications.payout_sent', null],
    ]);
  });
  it('cancellation', async () => {
    const { CANCELLATION_SAGA } = await load();
    expect(CANCELLATION_SAGA.name).toBe('cancellation');
    expect(rows(CANCELLATION_SAGA)).toEqual([
      ['mark_cancel_requested', 'compensatable', 'orders.mark_cancel_requested', 'orders.clear_cancel_requested'],
      ['release_or_restock_inventory', 'compensatable', 'inventory.release_or_restock', 'inventory.re_reserve'],
      ['reverse_commission_ledger', 'compensatable', 'ledger.reverse_commission', 'ledger.reinstate_commission'],
      ['start_refund', 'pivot', 'refunds.start_refund_saga', null],
      ['mark_cancelled', 'retriable', 'orders.mark_cancelled', null],
      ['notify_seller_and_shopper', 'retriable', 'notifications.order_cancelled', null],
    ]);
  });
});

