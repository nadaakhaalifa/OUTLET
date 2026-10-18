# Addresses and courier coverage (master prompt section 7, checkout step 1)

Status: implemented (Phase 1). Migration `0050_addresses.sql`. Module `apps/api/src/modules/addresses`, pure rules in `packages/domain/src/addresses`.

## Flow
Shopper manages up to 10 structured Egyptian addresses (governorate, city/district, street, building, floor, apartment, landmark, optional map pin, recipient name, EG mobile phone). Checkout resolves the chosen address, rejects uncovered ones, and copies it into an immutable `delivery_snapshots` row.

## Rules
- Governorate and city must exist in the coverage tables (27 governorates, major cities, Arabic and English names; seeded from `coverage-data.ts`, admin-editable later). Unknown code => 400 `unknown_governorate` / `unknown_city`.
- Courier coverage per courier at governorate level with city-level overrides; an address is `covered` if any courier covers it, `not_covered` otherwise, `unknown` when no coverage rows exist. Not-covered addresses can be saved (flagged honestly) but checkout answers `not_covered`. COD collection needs a covering courier with `cod_supported`.
- Phone: Egyptian mobile (010, 011, 012, 015), normalized to E.164; Arabic-Indic digits accepted.
- Exactly one default per user (partial unique index). The first address is the default; deleting the default promotes the most recent remaining one. Max 10 per user (409 `address_limit_reached`). Duplicates are detected with an HMAC blind index over the normalized location fields (409 `address_duplicate`).
- `cod_eligible` is server-computed: landmark AND map pin AND covered AND a COD-capable courier. Map pin must lie inside Egypt's bounding box.
- `quality_score` 0-100, pure completeness function (pin 20, street 15, landmark 15, phone 10, recipient 10, building 10, governorate 5, city 5, floor 5, apartment 5).

## Data and privacy
Tables: `saved_addresses`, `delivery_snapshots`, `gift_address_tokens`, `couriers`, `coverage_governorates`, `coverage_cities`, `courier_coverage` (tagged in `docs/privacy/data_inventory.yaml`). P3 fields (phone, street, building, floor, apartment, landmark, map pin) and the recipient name are field-envelope encrypted through the `FieldCipher` port (AAD `address:<id>:<field>`; snapshots use `snapshot:<id>:<field>`). With the KMS Unconfigured, saving or reading an encrypted address answers 503 `provider_not_configured`; an empty list and the coverage endpoints keep working. RLS on all user tables; responses are `no-store`.

## Snapshots and gifts
`AddressService.snapshotForOrder(buyer, orderRef, addressRef)` re-encrypts a copy; idempotent per (buyer, orderRef); UPDATE/DELETE are blocked by trigger, so editing or deleting the address never changes order history. A gift token (`gift_` + 128-bit random, only its SHA-256 stored, expiry, revocable) lets a buyer purchase to a recipient: the buyer learns only the destination governorate and coverage; the snapshot holds the real address, is `gift=true`, never COD, and is read by couriers via `courierSnapshot` (system role only, no buyer route). Erasure: snapshots are retained pseudonymized (crypto-shred) under the tax retention period.
Checkout wiring: `checkoutAddressPort` implements checkout's `AddressPort` (first name, governorate, coverage). Calling `snapshotForOrder` from the checkout commit step is a follow-up for the checkout owner.

## API
`GET/POST /v1/me/addresses`, `GET/PATCH/DELETE /v1/me/addresses/{id}`, `POST /v1/me/addresses/{id}/default`, `GET /v1/coverage/governorates`, `GET /v1/coverage/cities?governorate=`. Writes need `Idempotency-Key`; owner only (not owned => 404); keyset cursors; per-user rate limits; Problem+JSON.

## Threats
BOLA (owner-keyed lookups, 404), enumeration (UUID ids, rate limits), PII at rest (envelope encryption, blind indexes), buyer learning a gift recipient's address (token resolves server-side, courier-only snapshot), history tampering (immutable snapshots), KMS outage (fail closed, no plaintext fallback).

## Defaults recorded (VERIFY)
Seed courier coverage is an assumption pending VR-11 (Bosta/Aramex contracts). Treating governorate and city as P2 is a proposal for the DPO.
