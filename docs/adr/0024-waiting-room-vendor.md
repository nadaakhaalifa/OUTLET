# ADR-0024: Waiting-room vendor

- Status: **Proposed, blocked on VR-16 (vendor, region, price) and ADR-0002**
- Date: 2026-10-11
- Deciders: CTO, Infra, Legal (data transfer)
- Spec refs: §16, §T7, §T9, Phase 2 spec 07

## Context and problem statement
Flash drops need an edge queue issuing signed admission tokens. Queue data (user id, device id, IP) is personal data; a global vendor may be a cross-border transfer.

## Considered options
1. **Cloudflare Waiting Room (edge SaaS).**
2. **Self-built queue** (Redis sorted set + signed JWT admission) behind the CDN.
3. Queue-it or similar specialist vendor.

## Decision (proposed default)
Option 2 for launch: the origin-side Redis FIFO queue and JWT admission already specified in spec 07, with the edge (CDN/WAF) only rate-limiting the queue endpoints. It keeps ticket data in the chosen region, avoids a processor DPA/TIA for this flow, and fails closed. Add Option 1 or 3 in front only if the 20x load test shows origin cannot absorb queue polling; the vendor then receives only an opaque session id, no user id. Vendors are compared on: Arabic UI, DPA/region, cost per million requests, token interop with our JWT.

## Consequences
Good: residency simple, full control of fairness (+-1% FIFO). Bad: we own bot and DDoS resilience on queue endpoints; more engineering.

## Owner decision required
Approve self-built default, or name a vendor after VR-16.

## Safe default if no answer
Option 2.
