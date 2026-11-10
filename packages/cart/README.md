# @outlet/cart

## Notes
- Threshold base: once promotions exist, the free-delivery base must subtract item-level promo discounts exactly once (master prompt section 6); today it is the live merchandise subtotal.
- Writes go to `store_free_delivery_settings` (store RLS) and are projected into the shopper-readable `cart_store_thresholds` in the same transaction. Bounds 0..1,000,000 minor; 0 (free for everyone) needs `allowFreeForAll: true`. Admin path: policy `store.threshold.write` (ops, finance) plus an audit entry via `AuditPort`.
- `catalog_public_listings_variants_gin` stays in this migration (a `sku_ids uuid[]` column would be catalog's projection to add later).
