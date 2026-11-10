# Spec: Shipping: inside Egypt and international

Status: draft v1 (2026-11-07), owner request. Builds on master prompt §21 (fulfilment), ADR-0006 (global-ready) and the UI reference spec.
All rates in this document are **examples**. Real rates come from courier contracts. ⚠ marks a VERIFY BEFORE LAUNCH item.

## 1. What the owner asked for
1. Delivery works **inside Egypt** and **internationally**.
2. A seller who ships internationally **must enter weight (and size) per product**, and checkout calculates shipping by weight.
3. Shoppers can filter by **Local / Global / Both** brands and by **Ship within Egypt / Ship abroad**.
4. It is clear **who pays customs duties and clearance fees** (the "airport fees").
5. Everything is shipped **legally**.

## 2. Seller setup (Seller Center → product → step "Shipping")
| Field | Rule |
|---|---|
| Ships from | Seller warehouse or the Outlet hub (governorate/city), or "Abroad: country X" for global sellers |
| Ships to | ☐ Inside Egypt · ☐ International. The seller picks countries or regions; international can only be ticked after **export KYC** |
| Actual weight | Required for every product, in grams, with the packed weight (product + box). **Required before publish if International is ticked.** Must be > 0 and ≤ 30 kg per piece (heavier = freight, not parcel) |
| Package size L × W × H (cm) | Required for international, optional for domestic. Used for volumetric weight |
| HS code + product description in English | Required for international. The AI suggests one; the seller confirms ⚠ |
| Country of origin | Required for international (e.g. "Made in Egypt") |
| Contents declaration | Material (e.g. 100% cotton) and value per unit, used on the customs form |
| Restricted-item check | Auto-blocks batteries/lithium, liquids, aerosols, perfumes, food, cosmetics, and anything on the destination's banned list, unless the courier allows it |
| Duties mode (international) | **DDP**: duties and taxes are paid at checkout, so the shopper pays nothing on arrival (recommended, Phase 3) · **DAP/DDU**: the shopper pays duties to the courier on arrival (allowed, clearly shown) |

## 3. How shipping price is calculated
```
volumetric_kg   = (L × W × H in cm) / 5000           # common express-courier divisor ⚠ per contract
chargeable_kg   = max(actual_kg, volumetric_kg), rounded up to the courier step (0.5 kg)
parcel_weight   = Σ(chargeable_kg of each item × qty) + packaging allowance (per courier rule)
shipping_fee    = courier_rate(origin_zone, destination_zone, parcel_weight, service)
                  + fuel / remote-area surcharges (from the courier rate card)
duties_estimate = (goods + shipping [+ insurance]) × duty_rate(HS code, destination)
                  + import VAT/GST of the destination      # only if above the de-minimis threshold ⚠
```
- **Inside Egypt:** zones by governorate (Cairo/Giza, Alexandria/Delta, Canal, Upper Egypt, Remote). Free delivery rules (≥ 2,000 EGP per store, Plus) apply to domestic delivery only.
- **International:** rates by destination zone and weight band from the courier contract (Aramex, DHL Express, FedEx, UPS or Egypt Post EMS ⚠). The fee is quoted live at checkout and **locked for 10 min** together with the price lock.
- Items from different sellers ship as separate parcels unless hub consolidation is enabled (V2), and each parcel is priced separately.
- **Money:** integer minor units, currency per market (ADR-0006). The display currency may be converted, but charging is always in a supported settlement currency ⚠.

## 4. Who pays what (shown before payment, no hidden fees)
| Cost | Inside Egypt | International: DAP (default at launch) | International: DDP (later) |
|---|---|---|---|
| Shipping fee | Shopper (or free by rule) | Shopper, at checkout | Shopper, at checkout |
| Customs duties + import VAT in the destination | n/a | **Shopper, paid to the courier on arrival**, with an estimate shown at checkout | **Paid at checkout**, so the shopper owes nothing on arrival |
| Courier clearance / disbursement fee ("airport fee") | n/a | Shopper, on arrival (amount shown as an estimate) | Included at checkout |
| Egyptian export clearance | n/a | Seller / courier (part of the shipping fee) | Same |
| Returns from abroad | n/a | Return shipping paid by the shopper unless the item is defective or wrong; duties are usually not refunded ⚠ | Same |

The checkout must show a box with this text: "International order: customs duties and fees of about X are paid by you to the courier on delivery. Refusing to pay them means the parcel is returned, and the return costs are deducted." The shopper ticks to accept.

## 5. Shopper filters and flow
- **Filter "Brands":** Local · Global · Both (default Both). "Local" = seller registered in Egypt with stock in Egypt. "Global" = international brand (via local distributor or shipped from abroad).
- **Filter "Delivery":** Ship within Egypt · Ship abroad. The shopper's destination country is remembered. Items that cannot ship to that country are hidden or greyed with the reason.
- **On the product page:** "Ships from {city/country}", "Delivers to {country} in X–Y days", "Estimated shipping {fee}" and, for international, "Estimated duties paid on arrival ≈ {amount}".
- **At checkout:** each parcel shows its weight, its fee and its delivery days. International parcels add the duties box (§4).

## 6. Legal requirements for shipping legally ⚠ (all to be confirmed with counsel and courier)
1. **Use licensed express couriers** for international parcels (Aramex, DHL, FedEx, UPS, Egypt Post). They prepare the export declaration and commercial invoice, and the courier is the declarant.
2. **The seller must be export-eligible**: a commercial register, tax card and, where required, registration on the **Egyptian exporters' register** ⚠. The VAT on exports is usually zero-rated, with documentation ⚠.
3. **The commercial invoice for each parcel** (AR/EN) lists the HS code, description, origin, value, weight and the shipper/consignee details. It is generated by the system from the product data.
4. **No restricted goods:** export-banned items, antiquities, counterfeit goods, and dangerous goods (lithium batteries, perfumes) unless the courier contract allows them. Destination bans are checked per country.
5. **Imports into Egypt** (global sellers shipping to Egyptian shoppers): the ACI pre-registration (mandatory for air cargo since 2026 ⚠), Egyptian customs duty and VAT, and the de-minimis/personal-use rules ⚠. **Phase 1 recommendation:** global brands sell through a local distributor or with stock already in Egypt. Cross-border import parcels wait until Phase 3.
6. **Sanctions and export controls:** screen destination countries and consignees.
7. **Consumer law:** the return and cancellation rights of the shopper's country apply to international sales ⚠. Start with a short list of destination countries.
8. **Personal data:** sending the shopper's address abroad to a courier is a cross-border transfer under PDPL. It needs a DPA with the courier and is covered by the transfer licence (ADR-0002).
9. **Payments:** accepting foreign cards and settling in a foreign currency need PSP support and CBE rules ⚠.

## 7. Data
- `product_shipping(sku_id, actual_g, length_cm, width_cm, height_cm, hs_code, origin_country, material, ships_domestic, ships_international, allowed_countries[], restricted_flags[])`
- `shipping_zones(market_id, courier, zone_code, countries[] | governorates[])`
- `rate_cards(courier, service, origin_zone, dest_zone, weight_from_g, weight_to_g, price_minor, currency, valid_from)`
- `duty_rules(dest_country, hs_prefix, duty_rate_bp, vat_rate_bp, de_minimis_minor, source, valid_from)`
- `shipment_quotes(id, order_group_id, parcels jsonb, fee_minor, duties_estimate_minor, incoterm DAP|DDP, expires_at)`

## 8. API
- `POST /v1/shipping/quote`: pure, no side effects; input is the cart and destination, output is per-parcel fees, days and a duties estimate. 30/min per user.
- `PUT /v1/seller/products/{id}/shipping`: seller scope; validates the weight and size rules.
- `GET /v1/shipping/countries`: the countries we ship to for each item or store.

## 9. Edge cases
- Weight is missing → the item cannot be sold internationally, and domestic shipping uses the category default plus a warning to the seller.
- The weight the courier measures is above the declared weight → the difference is charged to the seller (seller-fault, ledger entry) and the seller's accuracy score drops.
- The shopper refuses to pay duties → the parcel goes back to the seller; return costs are deducted as disclosed.
- One item in the cart cannot ship to the destination → it is blocked at checkout with the reason, and the rest of the cart continues.
- Currency rates change during checkout → the quote stays locked for 10 min.

## 10. Phasing
- **MVP (web):** Egypt-wide delivery by zone and weight (Bosta, then Aramex), seller weight fields required, the Local/Global/Both filter, and the "Ship within Egypt" filter.
- **V2:** international **export** from Egyptian sellers to a short list of countries (e.g. KSA, UAE) via Aramex/DHL, under **DAP** with a duties estimate.
- **V3:** DDP (duties paid at checkout), cross-border import into Egypt, and hub consolidation for international.

## 11. Verify register
- **V32:** export eligibility and exporters' register requirements for small sellers, and zero-rated VAT documentation.
- **V33:** courier rate cards, volumetric divisor, restricted items, and DAP/DDP support (Aramex, DHL, Egypt Post).
- **V34:** destination duty, de-minimis and consumer-law rules for the first export countries.
- **V35:** Egypt import rules (ACI, personal-use limits) for cross-border sellers.
- **V36:** PSP support for foreign cards and multi-currency settlement.
