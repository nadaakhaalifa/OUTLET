# Threat model 09: price crawler and channel integrations

Status: Draft for review · Date: 2026-10-11 · Spec refs: §9.2, §T3, API7, API10 · ADR-0027 (egress isolation, Proposed) · Code: none. Flag `kill.crawlers` exists; `apps/api/src/modules/price-integrity` consumes internal price events only; no `apps/crawler`, no Shopify/Woo OAuth connector in the repository.

## Trust boundaries (design)
Seller-verified domain (untrusted HTML/JSON) to isolated crawler workers to proxy to evidence store to scoring. Crawler credentials never hold internal network or DB access.

## Threats and required controls
| ID | STRIDE | Threat | Required control | Proving test (to be written) | Status |
|---|---|---|---|---|---|
| CRL-E1 | E | SSRF to metadata/private IPs, DNS rebinding | Egress proxy allow-list, private-range block, resolve-then-connect | SSRF fixture suite (169.254.169.254, rebinding) | not implemented |
| CRL-T1 | T | Hostile page manipulates evidence or LLM extractor | Parse to schema; seller text untrusted in LLM (07) | adversarial HTML corpus | not implemented |
| CRL-D1 | D | Crawl hammers a seller or loops | robots.txt, <= 1 req/5 s per domain, ETag/If-Modified-Since | politeness unit test | not implemented |
| CRL-S1 | S | Seller points domain at a competitor | Domain ownership verification | verification flow test | not implemented |
| CRL-I1 | I | OAuth tokens for channels leak | Tokens by KMS reference only | secret scan + schema test | not implemented |
| CRL-R1 | R | Evidence staleness not visible | Evidence stale after 72 h degrades claim to plain price | already covered in `price-integrity/test/service.test.ts` "stale external evidence blocks the claim (fail closed)" | consumer side implemented+tested; producer absent |

## Residual risk
All external evidence is absent today; keep `kill.crawlers` off. Legal basis for crawling and seller consent text depend on the Seller Agreement (VERIFY with counsel).
