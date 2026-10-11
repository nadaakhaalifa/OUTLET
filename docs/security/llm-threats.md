# LLM threats: OWASP Top 10 for LLM Applications (2025) per feature

Status: Draft for review · Date: 2026-10-10 · Spec refs: §T12, §11 (stylist), §4 (search), §9 (price integrity), §18 (VoC), §23 (support), §B1, ADR-0002 · Companion: `docs/security/threat-models/stylist-and-llm-gateway.md`

## State and boundaries

- **No LLM code exists.** `llm-gateway` is not in the repository, no vendor is chosen (open question 2) and no personal data may reach a vendor until ADR-0002 is accepted. Every control below is `planned`. The nearest repository evidence is the dependency-cruiser configuration (`.dependency-cruiser.cjs`) that can enforce "provider SDK imports only inside `llm-gateway`" once the module exists, and the analytics PII guard (`packages/analytics/src/pii.ts`) whose patterns the gateway scrubber can reuse. Neither is a gateway control today.
- **Gateway rule (spec §T12).** Every call goes through `llm-gateway`: provider abstraction, versioned prompt registry, schema-constrained outputs, PII scrubber, injection heuristics, per-feature cost budgets and circuit breaker, caching, eval suites (golden sets in Arabic and English, regression on every prompt change) and an audit record of prompt hash, model and tokens with no raw P2 or P3.
- **Data rule.** Only P0 and P1 data and scrubbed prompts leave the approved region. P2 and P3 require `cross_border_ml` consent and a licence (open question 2, hard-rule default). **VERIFY BEFORE LAUNCH.**
- **Agency rule.** The model is never an authorization principal, never sets a price, stock level, discount or entitlement, and has no write tools.
- **Fallbacks.** Each feature has a non-LLM fallback and a kill switch (spec §A2.12): stylist falls back to rules, search parse falls back to keyword search, attribute extraction falls back to seller-provided fields plus the deterministic parsers, VoC and copywriting simply stop.

Test IDs `LLM-T01` to `LLM-T14` are defined in the stylist and gateway threat model. IDs `LLM-T15` and above are introduced here and listed at the end.

## Feature inventory

| # | Feature | Input (trust) | Output | Tools | Data class reaching the model | Spec |
|---|---|---|---|---|---|---|
| F1 | Stylist outfits, complete-the-look, capsule planner | User request and budget (untrusted), catalog text (untrusted seller content) | JSON of product IDs and reasons | Read-only: search, stock, size label, budget | P0 and P1 only; size as a label; budget as a bucket, not raw P3 | §11 |
| F2 | Stylist chat | Free user text (untrusted) | Short text plus product-ID cards | Same read-only set | P0 and P1; no order history | §11 |
| F3 | NL search parsing (`POST /v1/search/parse`) | Free user text (untrusted) | `SearchFilter` JSON validated by Zod | None | P0 only (query text, scrubbed) | §4 |
| F4 | Catalog attribute extraction (vision and text) | Seller title, description, images (untrusted) | Attributes JSON and embeddings | None | P0 seller content | §11, §9 |
| F5 | Price-evidence extraction (invoice or tag photo OCR plus LLM) | Seller-uploaded images (untrusted, may contain PII and hostile text) | Structured evidence fields with confidence | None | Seller business documents, treated as P2; kept in region | §9 |
| F6 | VoC weekly summary | Aggregated review and ticket topics (contain user text) | Report text for staff and per-seller | None | Aggregates with PII stripped before prompt | §18 |
| F7 | Seller copywriting assistant | Seller draft and product facts (untrusted) | Suggested text; seller must accept | None | P0 | §19 |
| F8 | Support reply suggestions | Current ticket thread (untrusted, may contain PII) | Draft reply; human sends | None | Current ticket only, scrubbed; P2 disallowed until licence | §23 |

## Matrix: LLM01 to LLM10 by feature

Legend: **A** applies and is controlled by the cited control; **L** low relevance, short rationale; **N/A** not applicable with reason.

| Risk | F1 Stylist outfits | F2 Stylist chat | F3 Search parse | F4 Attribute extraction | F5 Price evidence | F6 VoC | F7 Copywriting | F8 Support suggestions |
|---|---|---|---|---|---|---|---|---|
| **LLM01 Prompt Injection** | A: seller text as delimited data; heuristics; ID-only output (LLM-T02) | A: same plus user text as data; no write tools (LLM-T02, LLM-T11) | A: schema-constrained, no tools, unparseable falls back to keywords (LLM-T15) | A: output validated against deterministic parsers; never sets price (LLM-T02, LLM-T14) | A: injection in image text cannot raise a claim; document-only evidence capped at 30 percent (PRICE-T10, PRICE-T11) | A: user text inside aggregates is data; output text only (LLM-T16) | A: seller is the author; output shown to seller, not published automatically (LLM-T17) | A: ticket text may carry injection; draft only, human sends (LLM-T18) |
| **LLM02 Sensitive Information Disclosure** | A: no P3 in prompt, size label only (LLM-T06) | A: scrubber on user text; no order, address or phone (LLM-T06) | A: scrubber; query text is P0 | L: seller content is public listing data | A: documents may contain tax IDs and bank data; scrub or redact before model, region-locked (LLM-T19) | A: PII stripped before prompt (LLM-T20) | L | A: scrubber; current ticket only; no cross-ticket context (ADM-T07) |
| **LLM03 Supply Chain** | A: provider and model version pinned; vendor DPA and TIA before use | A: same | A: same | A: same plus any open-weight or vision model provenance recorded | A: OCR engine and model pinned | A: same | A: same | A: same. All via the gateway: SBOM covers SDKs, model IDs recorded in audit (LLM-T21) | 
| **LLM04 Data and Model Poisoning** | A: embedding drift checks; no training on user data without consent (LLM-T14) | L: no fine-tuning planned | N/A: no training on queries | A: poisoned attributes flagged by consistency check (LLM-T14) | A: model-extracted values never override deterministic checks | L | N/A | L: no fine-tuning on tickets |
| **LLM05 Improper Output Handling** | A: Zod-validated IDs, catalog join, no markup (LLM-T03, LLM-T13) | A: text escaped and rendered as plain text; cards from validated IDs (LLM-T13) | A: Zod filter schema; values never concatenated into queries (LLM-T13, LLM-T15) | A: attributes validated against enumerations (LLM-T13) | A: numbers parsed and range-checked (PRICE-T08) | A: rendered as escaped text | A: escaped; no HTML accepted from the model | A: plain text; human reviews |
| **LLM06 Excessive Agency** | A: no write tool; add-to-bag needs user tap and revalidation (LLM-T11) | A: same (LLM-T11) | N/A: no tools | N/A: no tools | N/A: no tools; result enters a scoring pipeline, not a decision | N/A | N/A | A: no send tool; human sends (ADM-T07) |
| **LLM07 System Prompt Leakage** | A: prompts are non-secret; no keys in prompts (LLM-T07) | A: same (LLM-T07) | A: same | A: same | A: same | A: same | A: same | A: same |
| **LLM08 Vector and Embedding Weaknesses** | A: per-scope vector store, no user data in shared index (LLM-T08) | A: same | N/A: no vector store (lexical plus Typesense) | A: embeddings from seller images are poisoning input; drift checks (LLM-T14) | N/A | N/A | N/A | N/A |
| **LLM09 Misinformation** | A: UI labels "AI suggestions"; prices and stock from source of truth (LLM-T12) | A: label; refusal to state price or stock from model text (LLM-T12) | L: result is a visible filter the user can edit | A: confidence thresholds; low confidence leaves attribute empty | A: confidence and human review queue above thresholds (PRICE-T11) | A: report labelled generated; numbers computed outside the model and inserted by template (LLM-T22) | A: seller reviews; factual claims about material or origin not auto-published | A: draft only |
| **LLM10 Unbounded Consumption** | A: 30 generations per day, 10 per minute, cost breaker (LLM-T09) | A: per-user token budget, turn cap, context cap (LLM-T09) | A: 10 per minute per user, input length cap (LLM-T09, LLM-T15) | A: per-image-version once, batch budget (LLM-T23) | A: per-seller upload cap, page cap, cost budget (LLM-T23) | A: weekly job with fixed budget | A: per-seller daily cap (LLM-T23) | A: per-agent cap |

## Cross-cutting controls

1. **Provider isolation (LLM-S1, LLM-T01).** Provider keys exist only in the gateway's secret scope, the egress allow-list lets only the gateway reach provider hosts, and the architecture rule forbids provider SDK imports elsewhere.
2. **Prompt registry.** Prompts are code-reviewed, versioned and hashed; changing a prompt or model triggers the golden-set regression gate (LLM-T04). Prompts are treated as public: no secrets, no per-user data, no business-sensitive thresholds that would help gaming the system.
3. **Untrusted content envelope.** User and seller text is passed in delimited, typed fields and the system prompt forbids following instructions inside them. This reduces risk; it does not eliminate it, so the design relies on output validation and absent write authority, not on the prompt.
4. **Output contract.** Every feature has a Zod schema. Invalid output is a typed error that triggers the fallback, never a retry loop with the raw output echoed back.
5. **Audit.** Each call records prompt hash, template version, model, tokens, cost, feature and decision; never raw P2 or P3 (LLM-T05).
6. **Kill switches and breakers.** One flag per feature and one global; budget exhaustion and provider errors flip the fallback automatically (LLM-T09, LLM-T10).
7. **Evaluation.** Golden sets in Arabic and English include an injection corpus, a PII canary corpus and a misleading-claim corpus. Dialectal Egyptian Arabic and mixed-script queries are part of the sets.
8. **Human review.** F5 results below a confidence threshold, and every F7 and F8 output, require a human action before effect.

## New tests defined here

| ID | Test |
|---|---|
| LLM-T15 | Search parse: hostile and over-long input (AR, EN, mixed script) yields a valid `SearchFilter` or the keyword fallback; the output never carries extra keys and never reaches SQL as text |
| LLM-T16 | VoC: review text containing instructions cannot change report structure or insert links; template inserts all numbers |
| LLM-T17 | Copywriting: output containing markup or URLs is escaped or rejected; nothing is published without the seller's accept action |
| LLM-T18 | Support suggestion: injection in a ticket cannot cause a send, a lookup of another ticket or an external fetch |
| LLM-T19 | Document extraction: canary national ID and IBAN patterns in a fixture image do not appear in the outbound request or in the audit record |
| LLM-T20 | VoC input fixture with canary phone, email and name never appears in the captured prompt |
| LLM-T21 | Audit record contains provider, model ID and version for every call; unknown model ID is refused by the gateway |
| LLM-T22 | VoC report numbers equal the source aggregates (property test); no model-generated number survives |
| LLM-T23 | Per-seller and per-feature budget exhaustion stops provider calls and returns the documented fallback |

## Open items

- LLM vendor, region, data-processing terms and transfer licence are unknown. Until they exist, F5 and F8 are designed but must not process real documents or tickets. **VERIFY BEFORE LAUNCH.**
- DPIA for the stylist, fit and budget models and a TIA for any cross-border processor are required by spec §T6 and are not written.
- Item names follow the 2025 list referenced in the master prompt; confirm against the published list at pen-test scoping. **VERIFY BEFORE LAUNCH.**
- Image-based prompt injection (text inside product photos) is covered only by the F4 and F5 consistency checks; a dedicated test corpus is still to be authored.
