# Product department attribute (decision and contract)

Status: built (migration 0086). Replaces the "no department concept" gap in `api-client-gap.md`.

## Decision
- `products.department` is `women | men | kids | unisex`, NOT NULL, default `unisex` (existing rows backfill by the constant default).
- Accessories is a **category**, not a department: an accessory is worn by any department, so a bag is `women` or `unisex` in
  department and `accessories` in category. The Home Accessories box therefore opens the `accessories` category (text query fallback).
- Filter semantics (`departments`, any-of): women and men also match `unisex`; kids is strict. Same rule in the in-memory engine,
  the Postgres FTS fallback and the mobile fake.
- Publish gate: no category requires a department yet, so a product left on `unisex` publishes with a non-blocking
  `publish_warnings: [{pointer: "/department", code: "department_not_chosen"}]` on the seller product wire.
- Privacy: P0 public attribute (`products.department`, `search_documents.department`).

## Surface
- Seller API: `department` optional on `POST /v1/seller/products` (default unisex) and `PATCH /v1/seller/products/{id}`; strict enum.
- Bulk CSV: optional `department` column (case-insensitive, blank = unisex, other value = `invalid_value` on that column).
- Search: `departments` array in `SearchFilter` (authenticated and `/v1/public/search` allow-list); `department` on product summaries
  and the public product. No facet counts: the engine contract returns totals only.
- Mobile: `/shop-all?department=women|men|kids` (removable chip, combines with category, budget, stores).
