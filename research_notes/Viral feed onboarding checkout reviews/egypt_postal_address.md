# Egypt postal codes, address form and phone fields for the Z-OUTLET checkout

Research depth: about 10 tool calls. Several primary sources were unreachable (Egypt Post 403, Bosta API reference not rendered, UPU PDF is compressed). Those are listed under Gaps rather than guessed.

## Can a postal code be reliably auto-filled from governorate/city/district in Egypt?

### Takeaway
No. I found no authoritative, open, bulk postal-code-per-district dataset for Egypt. The format itself is disputed (7 digits per UPU and Google data, 5 digits per generic guides). The safe design is an optional postal-code field that stays blank unless we hold a trustworthy code.

### Cited Findings
- UPU's Egypt addressing reference describes a 7-digit postcode placed below the locality, with digits that encode province, locality, neighbourhood and community — [DataHub licensing note citing UPU](https://datahub.io/logistics/postal-codes-eg/.licensing-notes); UPU document: [UPU Egypt PDF](https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/egyEn.pdf) (I could not read the PDF text myself; the 7-digit claim comes from the search summary and DataHub).
- Google libaddressinput data for EG accepts either 7 or 5 digits (examples 4460232 and 5734356). Layout is name, organisation, street, city, state, postal code; 27 governorates with Arabic names and ISO codes — [libaddressinput EG](https://www.gstatic.com/chrome/autofill/libaddressinput/chromium-i18n/ssl-address/data/EG). I did not extract whether `zip` is in the `require` list.
- GeoNames lists the format as `#####` on its country page — [GeoNames Egypt](https://geonames.org/countries/EG/egypt.html). The DataHub note reports `EG.zip` returns 404, so GeoNames has no usable Egypt postal data (one secondary report, not verified by me) — [DataHub](https://datahub.io/logistics/postal-codes-eg/.licensing-notes).
- DataHub's 2026-09-15 re-check: `egyptpost.gov.eg` returned 403 on repeated tries; no bulk download or API; `data.gov.eg` does not resolve; CAPMAS publishes boundaries and locality files without postcodes; the free UPU Universal POST*CODE Africa sample has an Egypt folder with 7-digit codes for Qina only (10 localities); the full database is commercial/NDA; no licence file in the sample. Verdict there: dataset not buildable — [DataHub](https://datahub.io/logistics/postal-codes-eg/.licensing-notes).
- GeoPostcodes sells a commercial Egypt dataset (claims 533,859 postcodes, markaz/qism shapefiles) and describes the format as 7 digits — [GeoPostcodes](https://www.geopostcodes.com/country/egypt/address-format/), [shapefile page](https://www.geopostcodes.com/country/egypt/shapefile/). Vendor claims, unverified, paid licence.
- Generic guides claim 5 digits with no authority cited — [Calpoly housing guide](https://grandavehousing.calpoly.edu/news/egypt-postcode-and-zip-code). Treat as low quality; the sources conflict with UPU/GeoPostcodes.
- Baymard says ZIP-based auto-detection of city/state is one of the two highest-impact ways to cut typing, and that fully automatic address lookup is most effective; most detail is Premium-gated — [Baymard ZIP detection](https://baymard.com/research-articles/zip-code-auto-detection), [Baymard address lookup](https://baymard.com/research-articles/automatic-address-lookup). Note this is the reverse direction (ZIP to city), which Egypt cannot support without data.

### Inferences
- Because codes are post-office-level and no open dataset exists, a governorate/city to postcode mapping would be guesswork; large new cities (6th of October, Sheikh Zayed, New Cairo, New Capital) have no verified coverage in anything I found. Inference.
- The 5 vs 7 digit conflict probably reflects legacy 5-digit codes versus the newer 7-digit system; I found no source confirming this. Validate with a permissive pattern `^\d{5}$|^\d{7}$` (as libaddressinput does), never reject on length mismatch beyond that.
- Do not autofill by guess: a wrong code is worse than a blank one.

### Gaps
- No official Egypt Post lookup content (site blocked) and no licence terms for any dataset.
- Not verified whether Egypt Post offers a lookup API or licensing for bulk export.
- Real-world usage frequency of postcodes in Egyptian delivery is not documented in anything I found.

## Is a postal code required for domestic delivery; what do couriers use?

### Takeaway
Couriers I could check model city/zone/district rather than postcode, but I could not read Bosta's own API reference. Treat postcode as non-required.

### Cited Findings
- Bosta community SDKs build a drop-off address from `cityCode` (e.g. `EG-01`), `zone`, `district`, `firstLine`, `secondLine`, `buildingNumber`, `floor`, `apartment`; no postcode field appears — [bosta-nodejs](https://github.com/bostaapp/bosta-nodejs), [bostaSDK on PyPI](https://pypi.org/project/bostaSDK).
- Bosta docs landing page exists but the city/zone/district endpoint pages did not render for me — [Bosta docs](https://docs.bosta.co).

### Inferences
- Since Bosta's create-delivery address has city, zone and district but no postcode, the courier mapping that matters is Bosta city/zone/district IDs, not postcodes. Inference from SDK parameters, not from official docs.

### Gaps
- Aramex Egypt, Mylerz, R2S, J&T, DHL Egypt: no documentation retrieved. Bosta cities/zones/districts endpoint and ID scheme: not confirmed.

## What Egyptian e-commerce checkouts do (Noon, Jumia, Amazon.eg, Talabat, Breadfast, Shein)

### Takeaway
Not established. My search returned nothing about these checkouts.

### Cited Findings
- Only generic notes that area dropdowns are common — [Geopostcodes address guide](https://www.geopostcodes.com/?p=39563). No competitor-specific evidence.

### Gaps
- Needs hands-on test checkouts (field list, postal-code optionality, map pin) for each retailer; I did not do this.

## Address-form best practice

### Takeaway
Minimise fields, use lookup/selection where reliable, keep postcode optional, and keep the existing structured fields plus map pin.

### Cited Findings
- Baymard: auto lookup most effective; hiding billing when same as shipping; Address Line 2 is a stumbling block — [Baymard](https://baymard.com/research-articles/automatic-address-lookup), summarised in public abstracts only.
- Google libaddressinput formats Egyptian addresses as street, city, state, postal code — [libaddressinput EG](https://www.gstatic.com/chrome/autofill/libaddressinput/chromium-i18n/ssl-address/data/EG).

### Inferences (from my general knowledge, not fetched this session; verify before citing)
- Use W3C autocomplete tokens (`name`, `tel`, `address-level1` for governorate, `address-level2` for city, `street-address`, `postal-code`) and `inputmode="tel"`.
- GOV.UK and Material guidance were not retrieved.

### Gaps
- W3C, GOV.UK, Material and Apple autofill pages not fetched; Baymard Premium figures (field counts) not accessible.

## Country and region auto-selection

### Takeaway
Not researched externally. Recommendation from reasoning only: country fixed to Egypt; governorate preselected from the last used address, never from device location unless the shopper explicitly taps "use my location" and consents; always show an edit affordance and confirm in the summary.

### Gaps
- No sources gathered on geolocation-consent patterns.

## Phone fields (two numbers, E.164, libphonenumber, PDPL)

### Takeaway
Repo already normalises one EG mobile to E.164. A second optional number needs new schema, its own consent/purpose and relay-masking before sellers see it. External libphonenumber and PDPL sources were not fetched.

### Cited Findings
- Spec B1 / section 1: phone is P3, one account per phone, OTP verification before first order, sellers get phone masked through a relay where the courier supports it, DPA in the seller agreement — [master prompt](/Users/nadakhalifa/OUTLET/docs/haul-master-prompt-v3.md).
- Repo: `normalizeEgPhone` accepts 010/011/012/015, Arabic-Indic digits, outputs `+201XXXXXXXXX` — `/Users/nadakhalifa/OUTLET/packages/domain/src/addresses/phone.ts`.

### Inferences
- Landline and non-mobile numbers are rejected by the current regex; a second contact number may legitimately be a landline. Decide whether to allow it.
- Purpose limitation for the second number: label it "backup contact for delivery only", no marketing use, not shown to sellers, courier-only.

### Gaps
- libphonenumber Egypt metadata not checked; WhatsApp channel rules not researched.

## Repo state today and recommended change

### Takeaway
Addresses model governorate and city, street, building, floor, apartment, landmark, pin, one phone. No postal code and no second phone.

### Cited Findings (read-only, local files)
- `saved_addresses` (migration 0050) has `recipient_name_enc`, `phone_enc`, `phone_blind`, `governorate_code`, `city_code`, `street_enc`, `building_enc`, `floor_enc`, `apartment_enc`, `landmark_enc`, `map_pin_enc`; no postal or second-phone column; same for `delivery_snapshots` — `/Users/nadakhalifa/OUTLET/packages/db/migrations/0050_addresses.sql`.
- Coverage seed: 27 governorates and about 80 cities (city is the finest level; no district/zone level), couriers `bosta` and `aramex` with governorate-level rows and few city overrides; marked as an assumption pending VR-11 — same migration, `packages/domain/src/addresses/coverage-data.ts`, `/Users/nadakhalifa/OUTLET/docs/specs/addresses.md`.
- Rules: coverage, COD eligibility (landmark AND pin AND covered AND COD courier), quality score, pin bounding box — `packages/domain/src/addresses/rules.ts`.
- API: `GET /v1/coverage/governorates`, `GET /v1/coverage/cities?governorate=` — `/Users/nadakhalifa/OUTLET/docs/api/openapi.yaml` lines 1818 and 1865.
- Mobile screen exists: `apps/mobile/src/app/addresses.tsx`, `apps/mobile/src/features/addresses/`. I only grepped it; no postal/zip hit.

### Recommended minimal changes (inference)
1. Add nullable `postal_code text CHECK (postal_code ~ '^(\d{5}|\d{7})$')` to `saved_addresses` and `delivery_snapshots`. It is optional, P2 at most; tag in `data_inventory.yaml`. Free text entry by the shopper, no autofill, until a licensed dataset exists.
2. Add `secondary_phone_enc`, `secondary_phone_blind` (nullable) to both tables, plus a recorded purpose; not OTP-verified, courier-only, excluded from seller views.
3. Add a finer courier-location level (district/zone ids) when Bosta's IDs are confirmed; map our `city_code` to Bosta city/zone IDs in a coverage table.
4. Dataset plan: (a) ask Egypt Post for a licensed export; (b) price UPU Universal POST*CODE or GeoPostcodes for all 27 governorates; (c) validate any set against new cities; (d) until then derive nothing.

### Gaps
- Licence, price and accuracy of paid datasets unknown; owner decision needed (contract/budget).
