# ADR-0040: GCC expansion: data, currency, tax and legal entity

- Status: **Proposed, blocked on VR-P3-07 and ADR-0002**
- Date: 2026-10-12
- Deciders: Founder, Finance, Legal, CTO
- Spec refs: P3 ("GCC expansion"), §0 (EGP only at launch), §B1, §B4, ADR-0002, ADR-0021

## Context and problem statement
The whole system assumes EGP, 14% VAT, Egyptian law (PDPL, CPL 181/2018, ETA), Egyptian couriers and Arabic as the Egyptian dialect. Entering another GCC country changes currency, tax regime, e-invoicing, data-protection regime, consumer law, payment methods, BNPL providers and couriers. None of those facts have been researched or verified for this project.

## Considered options
1. **Egypt only until the foundation is multi-market ready** (default): build only market-agnostic seams now.
2. **Single shared deployment, per-market configuration** (currency, tax table, legal texts, courier set, PSP set, residency tag).
3. **Separate deployment per country** with a shared codebase.

## Decision (proposed default)
Option 1 now: introduce `market` as a first-class config concept (currency code with minor-unit exponent, tax table id, locale set, legal-text bundle, courier set, PSP set, residency zone) in a spec, with money kept as integer minor units plus ISO currency (already the rule). EGP piastres assumes exponent 2; currencies with exponent 3 must not be assumed away. Choose between 2 and 3 only after counsel advises on each target country's data-localisation rules (ADR-0002 must be Accepted first). No market is enabled without its own verify-register rows.

## Consequences
Good: no premature fork. Bad: expansion needs a second legal and tax research pass per country.

## Owner decision required
Which country first; entity and bank set-up; whether to share or split deployments.

## Safe default if no answer
Egypt only; `market` abstraction built behind the single `EG` value.
