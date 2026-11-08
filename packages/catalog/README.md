# @outlet/catalog

Catalog module (P1-01a/b): categories, attribute sets, brands, stores, listings (`products`), variants (`skus`), condition grades,
defect cards (immutable versions) and the QR defect passport. Migration: `packages/db/migrations/0010_catalog.sql`.
No HTTP here; the API layer calls these services with a `@outlet/policy` `Principal`.

## Shape
- `domain/`: Zod DTOs for the OpenAPI catalog schemas, listing state machine (typed `InvalidTransitionError`), attribute validation
  (typed attributes, strictly increasing size runs), pure activation rules.
- `application/`: `CategoryService`, `BrandService`, `StoreService`, `ListingService`, `VariantService`, `DefectService`
  (cards and passports), `PublicCatalogService` (shopper reads). All take `{ client: RoleSqlClient<"outlet_app">, marketId }`.
- `testing`: `countQueries` and `expectQueryCount` (statement-count assertions for the no-N+1 rule; the context-binding `set_config` is excluded).

## Rules worth knowing
- Seller operations: `authorize()` first (foreign store = `not_found`, wrong role = `forbidden`, non seller staff = `forbidden`), then one
  transaction bound to the store context so Postgres RLS enforces the same boundary.
- Optimistic locking: every mutating call takes the version it read; a stale version throws `CatalogError("conflict")`.
- Activation blocks with `CatalogError("activation_blocked")` whose `details` are the reason codes (`activationReasons`).
- Outbox events in the same transaction: `listing.activated`, `listing.updated`, `price.changed` (amounts are decimal strings).
- Public reads use the published read model (`catalog_public_*`, P0 only, no tenant column). Services write it in the same transaction as the
  source row. Reason: the RLS audit (ADR-0011) only allows exception policies for `outlet_auth` / `outlet_worker`, so a public-read policy on a
  tenant table is not possible without weakening the audit.
- No "was" price is stored or shown here; `PriceDisplay.claim_type` is always `plain` until Price Watch overlays a verified claim.
- Keyset pagination, max 50 per page, cursor = (timestamp text with microseconds, id).
