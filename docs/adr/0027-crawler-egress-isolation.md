# ADR-0027: Crawler egress isolation

- Status: **Proposed**
- Date: 2026-10-11
- Deciders: CTO, Security, Infra
- Spec refs: §9.2, §T3, §T5 (API7), Phase 2 spec 08

## Context and problem statement
The crawler fetches seller-supplied URLs and renders untrusted pages in a headless browser. Risks: SSRF to internal/metadata endpoints, browser exploits, IP reputation, and leakage of platform credentials.

## Considered options
1. **Dedicated VPC/subnet with no route to internal networks, egress only via an allow-listed forward proxy, ephemeral sandboxed browser workers, writes through an ingest API.**
2. Same cluster, network policies and an application-level URL validator only.
3. Third-party scraping API.

## Decision (proposed default)
Option 1. Controls: separate cloud account/VPC, default-deny egress with proxy that resolves DNS and blocks private/link-local/metadata ranges (IP pinning vs rebinding), no instance role with data access, IMDSv2 hop limit 1 or no metadata, workers short-lived per job with seccomp and read-only FS, secrets absent, outbound only 80/443, response caps, separate observability, static egress IPs published to sellers. Application SSRF validator remains as second layer. Option 3 rejected: sends seller domains and our match targets to another processor, cost, less control of politeness. Option 2 rejected as insufficient against a browser escape.

## Consequences
Good: strong blast-radius limit. Bad: extra infra and cost; ingest API to maintain.

## Owner decision required
None blocking; approve budget.

## Safe default if no answer
Option 1.
