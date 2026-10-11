# Threat model: stylist and LLM gateway

Status: Draft for review · Date: 2026-10-10 · Method: STRIDE per element, mapped to OWASP LLM Top 10 2025 (see `../llm-threats.md`) · Spec refs: §11, §T12, §B1, ADR-0002 · Modules: `stylist-gateway`, `llm-gateway`, `recommendations-gateway`, ML services

No code exists. No LLM vendor is chosen (open question 2) and no personal data may reach one until ADR-0002 is accepted.

## Scope and assets
Prompt registry, system prompts, gateway audit log (prompt hash, model, tokens), product attributes and embeddings, per-user style vectors, outfit results, per-feature budgets, provider API keys.

## Trust boundaries
Seller text and scraped content (untrusted) to gateway to model provider (external, possibly cross-border) to schema validator to application. The model is never an authorization principal.

## Threats and controls
| ID | STRIDE | Threat | Control | Proving test | Status |
|---|---|---|---|---|---|
| LLM-S1 | S | Caller bypasses the gateway and calls a provider directly with a leaked key | Provider keys only in the gateway's secret scope; egress allow-list permits only the gateway to reach provider hosts; dependency-cruiser forbids provider SDK imports outside `llm-gateway` | LLM-T01 architecture test: provider SDK import outside the gateway fails CI | planned |
| LLM-T1 | T | Prompt injection through product titles, descriptions, reviews or scraped pages (LLM01) | Untrusted text passed as delimited data fields; system prompt forbids following instructions in data; injection heuristics; outputs schema-constrained; tools read-only | LLM-T02 injection corpus (AR and EN) in product data cannot change output schema, tool calls or selected IDs beyond catalog constraints | planned |
| LLM-T2 | T | Model output used to set prices, stock or authorization | Prices, stock and size are never generated: output is product IDs validated against the catalog; add-to-bag needs a user tap and re-validates stock and price | LLM-T03 property test (10k random catalogs): outfit total never exceeds budget; any generated ID not in catalog is dropped | planned |
| LLM-T3 | T | Prompt or model version change silently degrades safety | Prompt registry versioned, golden sets AR/EN with regression gate on every prompt or model change, shadow deploys | LLM-T04 CI eval gate fails on regression against golden set | planned |
| LLM-R1 | R | No record of what the model was asked or returned | Audit log of prompt hash, template version, model, tokens, cost, decision; raw P2/P3 never stored | LLM-T05 audit row exists per call and contains no raw user fields | planned |
| LLM-I1 | I | P2/P3 (measurements, DOB, address, budget, phone) sent to an external model (LLM02) | PII scrubber plus field allow-list at the gateway; size passed as label not measurements; residency rule requires `cross_border_ml` consent and licence; feature disabled when flag off | LLM-T06 canary-PII fixtures never appear in the outbound request captured by a fake provider | planned |
| LLM-I2 | I | System prompt or secrets disclosure (LLM07) | No secrets in prompts; prompts treated as non-secret; keys in secret manager | LLM-T07 secret scanner over prompt registry in CI | planned |
| LLM-I3 | I | Cross-user leakage through shared caches or vector stores (LLM08) | Cache key includes filters hash and scope, no user data in shared indexes, vector store per tenant scope | LLM-T08 user B never receives user A's cached personal result | planned |
| LLM-D1 | D | Cost exhaustion or "denial of wallet" (LLM10) | Per-user token budgets (30 generations per day free), rate 10/min on outfit endpoint, per-feature and global cost circuit breaker, cache by filters hash, kill switch | LLM-T09 budget exhaustion returns the rule-based fallback and no further provider calls | planned |
| LLM-D2 | D | Provider outage | Rule-based fallback (templates, popularity, colour rules); chat disabled with structured UI; breaker with timeouts | LLM-T10 chaos: provider down yields fallback within p95 target | planned |
| LLM-E1 | E | Excessive agency: model triggers purchases or data changes (LLM06) | Tools are read-only (search, stock, size, budget); no write tool exists | LLM-T11 tool registry test: every registered tool is flagged read-only | planned |
| LLM-E2 | E | Misleading AI claims and over-reliance (LLM09) | UI labels "AI suggestions", prices and stock shown from source of truth, never from model text | LLM-T12 UI snapshot test for label presence; no price strings originate from model output | planned |
| LLM-E3 | E | Unsafe output handling: model text rendered as markup or passed to interpreters (LLM05) | Output is JSON validated by Zod, free text escaped, never evaluated or used in queries | LLM-T13 fuzz outputs with markup and SQL-like strings do not reach any interpreter unescaped | planned |
| LLM-E4 | E | Data and model poisoning through crowd data, reviews or attribute extraction (LLM04) | Attribute extraction results validated against deterministic parsers where possible, model versions pinned, anomaly checks on embedding drift | LLM-T14 poisoned-attribute fixture is flagged by drift or consistency check | planned |

## VERIFY BEFORE LAUNCH
LLM vendor identity, data processing terms, region and transfer licence (register row 2), DPIA for stylist, fit and budget models (§T6). Nothing about a vendor's guarantees is assumed.

## Residual risk
Prompt injection cannot be fully prevented; the design limits blast radius by removing write tools, price generation and personal data from the model's reach.
