# ADR-0018: Authoritative vocabularies (OrderGroup states, consent purposes, price-history path, ledger owners)

- Status: **Proposed** (applied as the safest default; owner may overrule)
- Date: 2026-10-10
- Deciders: Tech Lead, DPO (consent), Owner
- Spec refs: A2.6, B1, §5, §T4; inconsistencies I-06, I-08

## Context

The Phase 0 audit found four names that differed between code, data-model docs and OpenAPI. A contract that disagrees with the code that enforces it is a bug waiting for the first client.

## Decision

Rule: **the executable, tested artefact wins; where none exists, the master prompt wins.**

| Topic | Authoritative | Change made |
|---|---|---|
| OrderGroup states | `ORDER_GROUP_STATES` in `packages/domain` (CREATED, RESERVED, PAYMENT_PENDING, PAID, CONFIRMED_COD, FULFILLING, COMPLETED, EXPIRED, FAILED, CANCELLED) | `docs/data-model/orders.md` and OpenAPI `OrderGroup.status` (lowercase wire form) now match. `awaiting_customer_action` and `PARTIALLY_FULFILLED` are not states: a pending 3-DS step is the checkout `client_action`; partial outcomes come from seller orders. |
| Consent purposes | Spec B1: nine purposes. Same set as `@outlet/privacy` and migration 0006 | OpenAPI `ConsentState` and `ConsentUpdate` enums now list the nine and no longer list `marketing_sms`. Docs no longer propose it. SMS stays transactional-only until the owner adds a purpose to B1 (then: spec, migration, code, OpenAPI together). |
| Price-history path | Spec §5: `GET /v1/products/{id}/price-history` | `docs/specs/price-integrity.md` aligned; OpenAPI note updated. |
| Ledger owner kinds | Domain `AccountOwner`: platform, psp, courier, bnpl_provider, bank, seller, shopper | Migration `0010` adds `bank`. Persistence keeps `store` and `user` because RLS policies (0007) key on them; the ledger adapter must map seller→store, shopper→user. |

## Consequences

- Clients can generate types from OpenAPI without status or purpose values the server rejects.
- Open: the seller/store and shopper/user mapping is documented but has no adapter code or test yet (no ledger persistence adapter exists). Add the mapping test with that adapter.
- Open: `ledger_account_types` seed table still not migrated (I-08).
