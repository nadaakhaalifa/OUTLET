# Runbook: restore drill

Targets from spec T9: **RPO 15 minutes, RTO 1 hour**. Cadence: monthly, and after any change to backup configuration. The drill restores to a scratch environment, never production, and runs the integrity job. Nothing here has been exercised: no database exists yet. Treat the first drill as the moment the targets are tested, not assumed.

## What must be in place first

- Continuous WAL archiving or point-in-time recovery enabled; base backup at least daily. An RPO of 15 minutes means archive lag alert at 5 minutes.
- Backups encrypted, in the approved region (ADR-0002), with keys recoverable separately from the data.
- A scratch environment that cannot reach production data or third parties (spec T7); outbound sends (SMS, PSP, courier) disabled.
- The integrity job: ledger sums to zero per currency, every posted order has balanced entries, outbox has no gaps, audit-log hash chain verifies, inventory units reconcile with order lines.

## Procedure

1. Record start time and choose a target recovery point (the latest, or a random point in the last 7 days).
2. Provision the scratch database from the latest base backup and replay WAL to the target point.
3. Record the recovered point; compute **achieved RPO** = now-at-failure minus last recovered transaction time.
4. Start the application in scratch with all outbound integrations stubbed.
5. Run the integrity job and a smoke test (browse, reserve, place a COD order, read ledger).
6. Record **achieved RTO** = time from step 1 to successful smoke test.
7. Tear down the scratch environment and verify data deletion.

## Pass criteria

- Achieved RPO at most 15 min and RTO at most 60 min.
- Integrity job reports zero violations.
- No production credentials or real outbound calls were used.

## On failure

Open a Sev3 ticket (Sev2 if RPO or RTO missed by a wide margin or integrity failed), fix, and re-run within 14 days. A missed target is a launch blocker once real orders exist.

## Record

Keep a drill log: date, operator, recovery point, achieved RPO and RTO, integrity result, issues. Patterns across drills feed the game day.

## Real incident use

For a real restore: declare Sev1, freeze writes, follow this procedure against a new instance, reconcile PSP settlements for the gap window (reconciliation-break.md), then cut over. Orders created in the lost window are recovered from PSP and courier records and the outbox where possible; communicate to affected shoppers.
