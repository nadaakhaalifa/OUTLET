# Threat model: price integrity engine and crawler

Status: Draft for review · Date: 2026-10-10 · Method: STRIDE per element · Spec refs: §9, §T3, §T5 (API7), §T12 · Modules: `pricing-integrity`, crawler workers (isolated), `search-sync`, product matching

No code exists. The VRP rules and the property test in §9.7 are specified but not implemented.

## Scope and assets
`price_events` (immutable), `channel_snapshots`, `product_matches`, `price_claims`, `enforcement_actions`, Price Trust Score, crawler headless pool and egress proxy, seller channel OAuth tokens.

## Trust boundaries
Seller-controlled web pages and APIs (untrusted, hostile content) to crawler pool (isolated segment, no internal credentials) to snapshot store to scoring service. LLM attribute extraction consumes untrusted seller text (see stylist-and-llm-gateway).

## Threats and controls
| ID | STRIDE | Threat | Control | Proving test | Status |
|---|---|---|---|---|---|
| PRICE-S1 | S | Seller claims a competitor's or non-owned domain as its channel to poison evidence | Domain ownership verification (DNS TXT or OAuth) before crawling; only seller-verified domains are fetched | PRICE-T01 unverified domain is never fetched | planned |
| PRICE-T1 | T | Price inflation then cut to fake a discount | VRP uses strictest of internal 30-day low and matched external 30-day low; any rise inside 30 days resets the reference | PRICE-T02 fast-check: a price raised then cut within 30 days never yields a claim above the true 30-day minimum (spec §9.7 acceptance) | planned |
| PRICE-T2 | T | Seller edits history or evidence after the fact | `price_events` append-only (UPDATE and DELETE revoked), evidence IDs stored on order lines (`vrp_snapshot`) | PRICE-T03 app role cannot update `price_events`; order line keeps its snapshot after later price changes | planned |
| PRICE-T3 | T | Product-match poisoning: duplicate listings, image reuse, near-duplicate images that reset history | pHash plus attribute matching to detect history-resetting duplicates; match only at `match_conf >= tau`; tau tuned on a labelled Egyptian set (VERIFY: precision target 0.98 unproven) | PRICE-T04 duplicate-listing fixture inherits original history, not a fresh one | planned |
| PRICE-R1 | R | Seller disputes an enforcement action | Every action stores evidence IDs, model version and rule; appeal re-scores automatically; suspension reviewed by a human within 5 business days | PRICE-T05 each `enforcement_actions` row links evidence and model version | planned |
| PRICE-I1 | I | Crawler or its proxy reveals internal network, credentials or user data | Dedicated egress proxy, no internal credentials or metadata endpoints reachable, crawler segment cannot reach databases except through a write-only ingest API | PRICE-T06 network policy test: crawler pod cannot reach internal ranges or the metadata address | planned |
| PRICE-I2 | I | SSRF: seller supplies a URL that resolves to a private IP, redirects, or rebinds DNS | Allow-listed verified domains only, resolve-then-connect with IP pinning, block private, loopback, link-local and metadata ranges, cap redirects and re-check each hop, DNS-rebinding guard | PRICE-T07 table of hostile URLs (private IPs, decimal and octal IP forms, redirect to metadata, rebinding stub) all blocked | planned |
| PRICE-D1 | D | Crawler abuse or being blocked; resource exhaustion by huge pages | robots.txt compliance, per-domain limit of 1 request per 5 s, response size and time caps, DOM hash change detection, evidence stale after 72 h degrades to plain price (fail closed) | PRICE-T08 stale evidence fixture yields no percentage claim | planned |
| PRICE-D2 | D | Malicious page exploits the headless browser | Sandboxed, non-root, disposable containers, no persistent profile, JavaScript execution limits, egress via proxy only | PRICE-T09 container hardening check in CI (non-root, read-only FS, seccomp profile) | planned |
| PRICE-E1 | E | Prompt injection in seller text or scraped page steers LLM extraction to produce a favorable price or match | Scraped text is data in delimited fields, extraction output is schema-constrained and cross-checked against deterministic parsers; LLM never sets a price | PRICE-T10 injection corpus fixtures cannot change extracted price or match decision | planned |
| PRICE-E2 | E | Document evidence (invoice photo) used to justify excessive discount | Document evidence supports a claim but alone can never justify more than 30% off; OCR provenance and age limit 180 days | PRICE-T11 document-only evidence capped at 30% in scoring | planned |
| PRICE-E3 | E | Mass false reports of price abuse | "Report price" rate-limited and treated as a weak signal | PRICE-T12 report burst does not change scoring beyond the cap | planned |

## VERIFY BEFORE LAUNCH
Crawling legality and terms-of-service posture per target, Seller Agreement monitoring consent, tau precision (register row 13), automatic suspension legality (row 15), Consumer Protection Law discount wording (row 7).

## Residual risk
Sellers who do not integrate and whose products have no history will see claims suppressed by design, which protects consumers and costs conversion. That is a product trade-off recorded in ADR-0006 as a known contradiction to settle.
