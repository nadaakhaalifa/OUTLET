# ADR-0008: Launch checklist versus phased features (Mega Drop and creators)

- Status: **Proposed, needs owner decision**
- Date: 2026-10-10
- Deciders: Founder, Product
- Spec refs: P1 (launch checklist), P3 (phases), section on drop types and waiting room, creator program, register rows VR-16, VR-17

## Context and problem statement

The launch checklist (P1) lists a "Grand Opening 72-hour Mega Drop, waitlist referral leaderboard, 50 micro-creators" as go-to-market items. The phase plan (P3) puts **all drop types and the waiting room in Phase 2** and **creators in Phase 3**. Phase 1 is the MVP (iOS, Seller Center, Admin). The checklist therefore asks for features that the phase plan schedules after launch. The owner has also decided to keep the full Phase 1 spec and to ship one Expo codebase.

## Decision drivers

- Do not make launch depend on features that carry unresolved legal rows (mystery box lottery rules VR-09, creator tax VR-17, waiting-room vendor VR-16).
- Keep a credible go-to-market moment.
- Do not pull Phase 2 and 3 scope into the 12-14 week MVP without removing something.
- Thin unit economics: a 72-hour event with deep discounts is a margin risk.

## Considered options

1. **Launch event without new engine features** (default): a time-boxed "Grand Opening" event built from Phase 1 parts only (curated store collection, a start and end time, Phase 1 vouchers, referral core). No waiting room, no mystery box, no price ladder. Creators are replaced by a manual, ops-run seeding list using plain referral links, no commission program, no creator payouts.
2. Pull the waiting room and one drop type forward into Phase 1.
3. Move launch to the end of Phase 2.
4. Drop the Mega Drop from the checklist entirely.

## Decision (proposed default)

Option 1. The P1 checklist is edited to say "Grand Opening event (Phase 1 capabilities only)" and "seeded creators via referral links (no payout program)". Capacity protection comes from the existing reservation TTL and a simple admission cap behind a feature flag, not from the Phase 2 waiting room. Drop types and the creator program stay in Phases 2 and 3.

## Consequences

- A launch-day spike has no edge waiting room. We mitigate with load testing (P1 reliability items) and a flag-controlled per-event purchase cap.
- No lottery-like mechanics at launch, so VR-09 does not block launch.
- No creator payouts, so VR-17 does not block launch.
- Marketing must not promise "Mega Drop" mechanics that do not exist.

## Owner decision required

Choose one of options 1 to 4. If option 2 or 3, name what leaves Phase 1 to make room and accept the new date. Also confirm the stock for the launch event is real inventory only (no invented scarcity, timers or discounts).

## Safe default if no answer

Option 1.
