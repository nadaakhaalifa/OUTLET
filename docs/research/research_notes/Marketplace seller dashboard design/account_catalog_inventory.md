# Seller account/team model, catalog and inventory management (Shopify, Amazon, Noon, Zalando, Etsy, Mirakl)

Note: coverage is partial (about 10 searches/fetches). Most items below are Shopify and Noon; Amazon permissions are from third-party guides. Items not found are listed under Gaps.

## 1. Account and team: roles, permissions, invitations, audit

### Takeaway
Shopify uses job-based roles that bundle granular permissions (a user can hold several roles; access is the union). Amazon uses an owner/admin plus per-feature secondary-user permissions, per marketplace or global, with a permissions history log. Exact permission lists for Noon, Zalando, Etsy and Mirakl were not found.

### Cited Findings
- Shopify: roles are job-based bundles of permissions; roles are created/assigned at Settings > Users > Roles; a user can hold several roles with combined access; "Merchandiser" (home, products, catalogs, content) is a predefined example — [Shopify Help Center, Users](https://help.shopify.com/en/manual/organization-settings/users)
- Shopify added separate permissions to view billing details and to add/remove staff; previously-full-access staff were downgraded to limited until granted them — [Shopify changelog](https://changelog.shopify.com/posts/new-permissions-available-for-staff-accounts)
- Shopify June 2026 changelog: POS staff management unified under roles; POS User Administrator role can assign existing roles — [changelog](https://changelog.shopify.com/posts/unified-pos-staff-management)
- Shopify blog gives granular example: support team with view-only product access — [Shopify blog](https://shopify.com/blog/staff-permissions)
- Amazon: Settings > User Permissions; only primary account holder or admin changes permissions; invite by name/email/language, then assign permissions after acceptance — [Koongo guide](https://help.koongo.com/en/articles/9833622-how-do-i-manage-users-and-permissions-in-amazon-seller-central), [ShoppingFeed](https://support.shoppingfeed.com/hc/en-us/articles/13480917849628-How-to-Manage-User-Permissions-for-Seller-Central)
- Amazon: regular permissions are per marketplace (advertising, inventory, reports); global permissions cover cross-marketplace settings (brand benefits, vacation, pricing); "View & Edit" users can change listings/stock but not permissions; a user-permissions history link exists — [MyAmazonGuy](https://myamazonguy.com/user-permissions-in-amazon-seller-central/) (third-party, verify against Amazon help)
- Amazon SP-API has separate permissions for service providers (third-party apps) — [Amazon dev docs](https://developer-docs.amazon/sp-api/docs/user-permissions-for-service-providers)

### Inferences
- Recommended MVP: owner, admin, and 3-4 fixed roles (catalog, inventory/warehouse, orders, finance, support) mapped to per-section view/edit flags; owner-only actions (billing, IBAN, removing owner). Advanced: custom roles as permission sets, multi-role union (Shopify), per-store scoping (Amazon per-marketplace analogue = per-store/location).
- Mandatory passkey/TOTP and an append-only permissions-change log are already in the master prompt (§19); Amazon's permissions history supports that pattern.
- Arabic-first: role names and permission labels need AR keys; RTL tables of permission matrices need mirrored checkbox columns.

### Gaps
- Exact full Shopify permission list: not found in search snippets (Help Center roles page not fully retrieved).
- Noon Seller Lab, Zalando Partner Portal, Etsy shop manager and Mirakl role/permission sets: not found.
- 2FA/passkey policies per platform, activity logs, multi-store/multi-location account model, storefront/policy settings: not found.

## 2. Catalog: creation, bulk import, validation, statuses

### Takeaway
Shopify's CSV has a documented column set and hard validation limits, three statuses (active/draft/archived) and an overwrite toggle. Noon uses category-specific Excel templates (NIS) with per-upload reports and review within 3 business days. Amazon uses flat files with a downloadable processing report.

### Cited Findings
- Shopify product CSV columns include Title, URL handle, Description, Vendor, Product category, Type, Tags, Status, SKU, Barcodes, Option1-3 name/value, Price, Compare-at price, Cost per item, Inventory tracker, Inventory quantity, Continue selling when out of stock, weight/dimensions, image URL/position/alt, SEO title/description, metafields (`product.metafields.<namespace>.<key>`), Collection — [Shopify CSV reference](https://help.shopify.com/en/manual/products/import-export/using-csv)
- Shopify required: Title for new products; URL handle + Title for updates; variant columns require Option1 name/value — same source
- Shopify limits: 3 options, 250 images, 250 tags, 20 barcodes, alt text 512 chars, SEO title 70, SEO description 320, UTF-8; partial packed dimensions cause error and the product is skipped; "Overwrite products with matching handles" off means matching rows are ignored; blank cell clears value when overwrite on; CSV cannot bulk-delete — same source
- Shopify Status values: active (default), draft, archived — same source
- Noon: Catalog > My Catalog > Add Products > Create Multiple Products; pick category; download EN or EN+AR template; upload NIS; reviewed/published within 3 business days; each upload gets a report with processed/error/mapping columns (Seller SKU assigned, pending, error) — [Noon help: Seller SKU bulk creation](https://helpcenter.noon.partners/en/category/product-listing/seller-sku-bulk-creation)
- Noon has separate imports for partner SKU price update, FBP stock update, and delete — [Noon help center](https://helpcenter.noon.partners/en/category/product-listing/partner-sku-delete-import); template headers must not be renamed or reordered (ASN sheet) — [Noon ASN bulk](https://helpcenter.noon.partners/en/category/fulfilled-by-noon-fbn/bulk-upload-creating-an-asn-with-an-excel-template)
- Amazon: processing report is a tab-delimited file under Add Products via Upload, with records processed vs successful; outdated templates and invalid GTIN/missing required fields are common failures (third-party) — [Amazon help](https://sellercentral.amazon.com/gp/help/external/201576740), [ChannelEngine](https://channelengine.com/en/blog/amazon-flat-files)
- Zalando: adult clothing needs at least 3 consecutive sizes, shoes 5; a size chart management tool and size-chart codes exist; zDirect account required — [Zalando Partner University](https://partner.zalando.com/university/article/onboard-your-articles), [size chart tool](https://partner.zalando.com/university/article/size-chart-management-tool-and-how-to-use-it)
- Etsy: deactivated listings are removed from the shop but remain in Shop Manager and can be reactivated; delete is permanent — [Etsy help](https://help.etsy.com/hc/articles/360000336187)

### Inferences
- MVP: CSV/XLSX template per category (AR+EN headers), dry-run that returns per-row error report (row, column, code, message AR/EN), statuses draft/pending_review/active/paused/archived, required fashion attributes (brand, category, size/colour variants, SKU, GTIN optional with validation, condition, size chart). Advanced: listing quality score, auto-moderation, bulk edit, background cleanup.
- Never allow a seller-typed "was" price to feed a % off claim (master prompt §9); the compare-at column pattern from Shopify should be ignored or labelled evidence-only.

### Gaps
- Amazon flat-file column list, Noon template column list and Noon status vocabulary: not found.
- Mirakl seller-portal import format/statuses (Mirakl OF01/PM01 files): not found.
- Listing quality score and moderation criteria for Noon/Zalando/Amazon: not found. Media specs (image size, ordering, background cleanup): not found.

## 3. Inventory: stock presentation, adjustments, sync

### Takeaway
Shopify tracks per-location quantities with CSV import/export and out-of-stock selling controls; detailed states and reason codes were not retrieved. Noon splits stock imports by fulfilment model (FBP).

### Cited Findings
- Shopify: Inventory page manages levels per variant and location, supports CSV import/export of quantities, continue-selling toggle, bin locations — [Shopify Help Center](https://help.shopify.com/en/manual/products/inventory/getting-started-with-inventory/inventory-states)
- Noon FBP stock update import is keyed on psku_code or Partner SKU; numeric or special-character SKUs cause mismatch errors — [Noon FBP stock import](https://helpcenter.noon.partners/en/category/product-listing/partner-sku-fbp-stock-update-import)
- Mirakl connectors treat ERP/WMS as stock authority, push offers (price, condition, lead time) and sync multi-location inventory (vendor claim, not Mirakl docs) — [Ecosire connector](https://ecosire.com/de/apps/shopify/shopify-mirakl-connector)

### Inferences
- Use on_hand / reserved / available (available = on_hand - reserved - safety stock), signed adjustments with mandatory reason codes (received, damaged, lost, correction, return restock, sync) and an append-only history; low-stock threshold per SKU with in-app+push alert; bulk update via CSV with dry-run; versioned idempotent channel sync to avoid overwriting reservations. This matches master prompt §20.2.

### Gaps
- Shopify committed/unavailable/incoming definitions and adjustment reason list, low-stock alert behaviour for Shopify/Amazon/Noon, stock table columns/filters: not found.

## 4. Delete vs archive vs deactivate

### Takeaway
Common pattern: draft/active/archived (Shopify) and inactive vs permanent delete (Etsy). Behaviour with existing orders not found in sources.

### Cited Findings
- Shopify archived = no longer available to sell — [CSV reference](https://help.shopify.com/en/manual/products/import-export/using-csv)
- Etsy deactivate is reversible; delete is irreversible — [Etsy help](https://help.etsy.com/hc/articles/360000336187)

### Inferences
- Recommend: soft-delete only; products with orders can be archived (hidden, order lines keep snapshots) but never hard-deleted; "paused" = temporary, auto-reactivation allowed; hard delete only for never-ordered drafts. Order lines must store title/price/VRP snapshot.

### Gaps
- Each platform's documented rule for deleting products that have orders: not found.
