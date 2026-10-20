# Runbook: PSP outage or degradation

Triggers: `SLOFastBurnCheckoutSuccess`, `SLOFastBurnPaymentConfirmationLatency`, PSP status page, circuit breaker open, webhook silence. Related: degraded-mode-matrix.md, reconciliation-break.md. No PSP is integrated yet; names and API steps below are placeholders to fill per provider once contracted. VERIFY BEFORE LAUNCH every provider-specific step.

## 1. Confirm

- Is it one method, one PSP, or all payments? Compare card, wallet, InstaPay, BNPL, Fawry success rates on the payments dashboard.
- Our side or theirs: check our recent releases, outbound errors versus 4xx, TLS and certificate errors (ADR-0007), and the PSP status page.
- Open a Sev2 (Sev1 if card payments and COD are both affected or money state is uncertain).

## 2. Contain

1. Trip or confirm the circuit breaker for the failing method; the checkout hides that method with the honest unavailable message, never a fake timer.
2. Keep COD and healthy methods available. Do not widen COD limits automatically; any COD cap change is an owner decision (unit economics are thin).
3. Failover to a second PSP only if one is contracted and enabled by flag (VERIFY: none yet).
4. Extend reservation TTL only per ADR-0011 rules; do not hand-extend holds on scarce stock.

## 3. In-flight payments

- Orders in `PENDING_PAYMENT` are not cancelled while the PSP is unreachable; they expire by TTL and a late success triggers re-reserve or automatic refund (ADR-0011).
- Pause automated refunds and captures that would fail repeatedly; queue them in the outbox with idempotency keys.
- Never retry a charge without the original idempotency key.

## 4. Communicate

- Support macro (AR/EN): payments for a method are temporarily unavailable, orders already paid are safe, no action needed.
- Status banner in app if the outage exceeds 15 min.

## 5. Recover

1. PSP reports recovery; half-open the breaker with a small share of traffic.
2. Restore the method when the failure ratio is back inside budget for 30 min.
3. Replay missed webhooks from the PSP API through the idempotent handler.
4. Run the reconciliation job for the outage window; handle breaks via reconciliation-break.md.
5. Refund any customer charged without an order.

## 6. After

Post-mortem within 5 business days. Record minutes of PSP downtime for SLA claims (VERIFY contract terms) and error-budget impact.
