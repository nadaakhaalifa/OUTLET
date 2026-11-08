# @outlet/returns

Returns, exchanges, disputes and refunds (master prompt section 22, 15.6). Money is integer piastres; every refund is ledger-first.

## Published rules

- **Windows.** Counted from the courier-confirmed `delivered_at`. A window of N days ends at the last millisecond of Cairo calendar day N after the delivery date (day 14 for change of mind, day 30 for defects); the first instant of day N+1 is refused. Open question V7.
- **Serial returners.** An order counts as returned when it has a non-exchange return whose inspection was accepted, or that has a refund. Rejected, cancelled or undisputed-and-closed returns do not count. A shopper with at least 10 delivered orders in the last 6 months and more than 60% returned loses free return shipping; the rule is published, never secret.
- **Return shipping fee.** For `payer = shopper` the fee is recorded on the return, not charged in Phase 1 (V7).
- **Dual approval.** Refunds and manual resolutions at or above the `refund.approve` threshold need an admin-access request (requester plus two other approvers), consumed exactly once and bound to the refund id (and, for manual resolution, the bank reference).
- **Seller account.** Whether a refund debits `seller_pending` or `seller_available` is decided when the entry is posted, under a `seller_orders` row lock, from the availability mover's `line_closed:{seller_order_id}` entry.
- **Provider rejection.** A final rejection reverses the refund entry and parks the refund in MANUAL_REVIEW; finance pays it out of band and `resolveManually` re-books it and posts Dr shopper_refunds_payable / Cr bank_collections. BNPL refunds never become wallet credit or cash.
- **Zero refund.** A return whose refundable total is 0 closes without a refund row.
- **Restock.** Inspection emits `return.restock_requested`; the consumer (`consumeRestock`) is an idempotent inbox consumer.
- **Jobs.** `autoApproveDue`, `closeRejected` (undisputed rejections close after `rejectedCloseDays`), `flagDisputeSlaBreaches` (`dispute.sla_breached`), `retryDue`.
