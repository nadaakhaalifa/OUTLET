# GCC market abstraction (EG only)

Status: implemented seam, single enabled market. Spec refs: P3 "GCC expansion", ADR-0040 (Proposed), ADR-0002 (Proposed), A2.4, A2.12, B1, B4. This document makes no legal claim about any country other than restating the Egyptian assumptions the system already had.

## What exists
| Item | Where |
|---|---|
| Pure `Market` value (code, currency code + minor-unit exponent 0..3, default/supported locales, IANA time zone, `vatConfigRef`, `agePolicyRef`, payment-method set, courier set, `legalTextSetKey`, `dataResidencyRegionKey`), `defineMarket` validation, `createMarketRegistry` | `packages/domain/src/market/market.ts`, exported as `market` |
| The only market, `EG_MARKET`, and the production registry `MARKETS` (one defined, one enabled) | `market/eg.ts`, `market/registry.ts` |
| Gate: the default market needs only static enablement; any other market needs static enablement AND release flag `release.market.additional_markets` (default false, fails closed) | `MarketRegistry.isAvailable/require`, `ADDITIONAL_MARKETS_FLAG`; flag in `packages/feature-flags/src/registry.ts` |
| Helpers that stop leakage: `assertMoneyInMarket`, `scopeToMarket`, `assertSameMarket`, `minorUnitsPerMajor` | `market/market.ts` |
| `market` column, `text NOT NULL DEFAULT 'EG'`, shape check only, on `carts`, `order_groups`, `price_events`, `promotions`, `budgets` (expand-only, constant default, no backfill) | migration `0072_market_column.sql`; tagged P1 in `docs/privacy/data_inventory.yaml` |
| Hard-coded `"Africa/Cairo"` in the three calendar-day helpers of ads, rewards and promotions now reads `EG_MARKET.timezone` (same value, same behaviour) | `packages/domain/src/{ads,rewards,promotions}/cairo.ts` |
| Tests: validation, registry gating, and fast-check properties that money in different currencies never mixes, ledger entries and the trial balance net to zero per currency, and market-scoped records never cross | `packages/domain/src/market/market.test.ts` |

## Invariants kept
- Money stays integer minor units (`bigint`) with `currency` on every amount; `Currency` is still the single literal `EGP`. Adding a currency is a deliberate, reviewed change to that type, not a side effect of defining a market.
- Ledger semantics are unchanged. `journal_entries` and `postings` gained no column; entries already must balance per currency.
- No existing row is migrated beyond the constant default. Migration 0073 was not needed and is filled by an intentional no-op so the sequence stays contiguous.

## What is NOT done (each is a VERIFY BEFORE LAUNCH row)
| Not done | Row |
|---|---|
| Per-country tax tables and VAT behaviour (`vatConfigRef` is only a key; only Egypt's 14% table exists) | VR-P3-MKT-01 |
| ETA equivalents (e-invoice and e-receipt) for any other country | VR-P3-MKT-02 |
| KSA, UAE or any other country's consumer, e-money, BNPL, gift-card and age rules | VR-P3-MKT-03 |
| Data residency and cross-border transfer for any other country (`dataResidencyRegionKey` is a label; ADR-0002 is Proposed) | VR-P3-MKT-04 |
| Adding a second currency to `Currency`, exponent-specific rounding and display, PSP currency support | VR-P3-MKT-05 |
| Per-market payment, BNPL and courier adapters; translated legal bundles; non-Cairo calendars and business days; entity and bank set-up | VR-P3-MKT-06 |

Further known gaps:
- Many other modules still contain their own `Africa/Cairo` literal (kyc-review, tax reconciliation, returns business days, payouts cycle, calendar, reminders). They were left alone on purpose: each has its own tested behaviour and a second market needs a real calendar design, not a string swap.
- `market` is not yet in indexes, RLS, API payloads or OpenAPI. Nothing reads the column in production code; it is a seam.
- The flag key is duplicated as a string in the domain (the domain may not import workspace packages); a drift between the two would fail closed.
- Payment and courier sets in `EG_MARKET` restate existing registries by value; the feature-flag registry remains the source for kill switches.

## Acceptance
- Only `EG` is defined and available; `require("ZZ", true)` throws.
- A test-only second market with exponent 3 and a different currency is accepted by `defineMarket` but is unavailable until statically enabled and the flag is true.
- Properties above hold across generated inputs.
