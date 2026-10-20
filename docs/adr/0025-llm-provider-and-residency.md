# ADR-0025: LLM provider and residency

- Status: **Proposed, blocked on VR-02 (cross-border transfer licence) and owner choice of provider**
- Date: 2026-10-11
- Deciders: CTO, DPO, Legal
- Spec refs: §T12, §B1, §11, Phase 2 spec 04

## Context and problem statement
Stylist, NL search parsing, attribute extraction, VoC and copywriting use an LLM. PDPL restricts cross-border transfer of personal data without a licence. All calls go through `llm-gateway`.

## Considered options
1. **External hosted API, strictly no P2/P3 data** (only catalog text, labels, anonymised bands), no user identifiers.
2. External API with P2 data under `cross_border_ml` consent and a transfer licence + TIA.
3. Self-hosted open-weight model in the ADR-0002 region.

## Decision (proposed default)
Option 1 for Phase 2: gateway enforces a typed allow-list of fields; prompts contain product data, occasion, size label, budget band, scope; never phone, DOB, address, measurements, exact budget or names. Personalisation happens outside the LLM (style vector, ranking). Provider chosen by evals (AR/EN golden sets) and DPA; provider abstraction keeps option 3 possible for P2 features later. Anything needing P2/P3 is blocked until VR-02 is Verified and consent exists. Rule-based fallback is mandatory.

## Consequences
Good: ships without a transfer licence; limited blast radius. Bad: less personalised language output; product text still leaves region (P0 only, but sellers' contact fields must be stripped).

## Owner decision required
Pick provider (or approve eval-based selection); confirm P0-only external calls are acceptable to Legal/DPO.

## Safe default if no answer
Option 1 with LLM features behind flags, default off in prod until DPO sign-off.
