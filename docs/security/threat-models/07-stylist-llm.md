# Threat model 07: stylist and LLM gateway

Status: Draft for review · Date: 2026-10-11 · Spec refs: §11, §T12, §B1, ADR-0002, ADR-0025 (Proposed) · Full OWASP LLM mapping: `../llm-threats.md`; earlier narrative: `stylist-and-llm-gateway.md`.

## What exists
Only `LlmGatewayPort` and `LlmUnavailableError` in `apps/api/src/modules/search/domain/ports.ts` with an in-memory implementation used by `POST /v1/search/parse`. There is no `llm-gateway` service, no stylist module, no provider, no prompt registry, no embeddings. `kill.stylist_llm` exists in the flag registry. Therefore most rows are not implemented by design; this file records what must be true before any vendor is connected.

## Threats
| ID | STRIDE | Threat | Control (planned unless noted) | Proving test | Status |
|---|---|---|---|---|---|
| LLM-T1 | T | Prompt injection in seller text steers outputs | Untrusted data in delimited fields; output is schema-constrained product IDs validated against catalog; no write tools | search.http.test.ts "rejects extra properties and empty text" covers only the filter schema | not implemented for stylist; partial (Zod filter output) for search parse |
| LLM-I1 | I | P2/P3 data (measurements, budget, address) sent to vendor | PII scrubber; size as label only; no cross-border without consent and licence | none | not implemented; blocked by ADR-0002/0025 and VR-02 |
| LLM-E1 | E | Model output changes price, stock or adds to bag | Prices never generated; add-to-bag needs user tap and server revalidation | none | not implemented (no stylist API) |
| LLM-D1 | D | Cost or latency exhaustion | Per-user token budgets, circuit breaker, cache, kill switch, rule-based fallback | search parse falls back on `LlmUnavailableError` (tested in search use-case tests, VERIFY title) | partial |
| LLM-R1 | R | No record of what the model was asked | Gateway audit of prompt hash, model, tokens, no raw P2/P3 | none | not implemented |
| LLM-T2 | T | Budget constraint violated by optimizer | Property test over random catalogs | none | not implemented (no optimizer) |

## Residual risk
No LLM vendor may receive personal data until ADR-0002/0025 are Accepted. Do not enable `kill.stylist_llm`. Re-run this model when the gateway is first written.
