# ADR-0012: Plus age gate (21 versus 18)

- Status: **Proposed, blocked on VR-08 (Legal)**
- Date: 2026-10-10
- Deciders: Legal, Product
- Spec refs: age policy table (Plus 21 default, admin-switchable to 18 after counsel sign-off), Plus section ("Age: 21+ by default"), phase list ("18+/21+ gates"), open question 6, VR-08, ADR-0004

## Context and problem statement

The age policy sets account and ordinary purchases at 18, and Plus (an auto-renewing contract) at 21 by default with an admin switch to 18. The phase list refers to "18+/21+ gates". The legal age of majority and the validity of recurring contracts with 18-20-year-olds are unverified. Setting 18 increases addressable users, but if 18-20-year-olds lack capacity the contract could be voidable.

## Decision drivers

- Contractual validity of auto-renewing subscriptions is unverified.
- Student and young-adult segment is commercially important in fashion.
- Gates must be reversible by configuration, not by release.
- A soft gate must not lock users out of benefits they already hold if the value changes.

## Considered options

1. **21 by default, configurable to 18 after counsel sign-off** (default).
2. 18 from day one.
3. 18 with a parental or guardian consent flow.

## Decision (proposed default)

Option 1. `age_policy.plus_min_age = 21` is a data value with an audit trail for changes. Users aged 18-20 carry `limited_capacity=true` and see "this feature requires 21+" with a help link; they can still buy ordinary items with non-recurring payment methods. Changing the value requires a recorded legal sign-off reference (the VR-08 evidence link). Existing subscribers are not cancelled if the age is raised; the change applies to new subscriptions only, and Legal decides the treatment of existing ones.

## Consequences

- Smaller early Plus audience; revenue forecasts should model 21+ only.
- Student plan (Phase 3) depends on this decision.

## Owner decision required

Legal to confirm the age of majority and whether 18-20-year-olds can enter auto-renewing contracts, in writing. Product to accept the revenue effect of 21.

## Safe default if no answer

Option 1, 21.
