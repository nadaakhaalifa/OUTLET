# Third-party integrations for Outlet NK (Egypt, 2026)

Research date: 2026-11-06. Method: about 12 web searches. WebFetch to primary docs was blocked in this session: sdk.invoicing.eta.gov.eg and developers.facebook.com did not resolve, so they would need to be allowed in the network settings. Most findings therefore come from search snippets of official developer portals or from third-party SDKs. Anything not confirmed from a source is listed under Gaps. Items in Inferences marked "(background, unverified)" come from the model's prior knowledge and must be checked.

## Payments: Paymob, Kashier, Fawry, Geidea, InstaPay, Meeza, payouts and sub-merchants

### Takeaway
Paymob documents a Unified Intention API (intention → client secret → Unified Checkout or Pixel → HMAC webhook) and a separate Payouts product. I found no public documentation of split or marketplace payments. Kashier is the only Egyptian PSP found with a documented marketplace primitive ("connected accounts"). Payout-to-sub-merchant flows are undocumented everywhere, which confirms that verify-register row 4 is still open.

### Cited Findings
- Paymob Create Intention: authenticate with the secret key. The response returns an order ID, an intention ID and a `client_secret`, which is used to open Unified Checkout or the embedded Pixel component. The notification URL receives the transaction callback (docs page, 2026) — [Paymob Create Intention](https://developers.paymob.com/paymob-docs/developers/intention-apis/create-intention); flow overview at [Paymob API getting started](https://developers.paymob.com/paymob-docs/integration-paths/apis)
- Paymob integration prerequisites: API secret key + public key, an integration ID per payment method, a webhook endpoint, and success/failure redirect URLs — [Paymob developers](https://developers.paymob.com/paymob-docs/developers)
- Paymob BNPL in Egypt: valU, Sympl, Souhoola "and others" are offered as methods. They are not enabled by default; the account manager enables them per merchant — [Paymob docs](https://developers.paymob.com/paymob-docs)
- Paymob "Beyond Payments" / Payouts: sends funds from the Paymob balance to vendors, employees or other recipients (page updated 15 Sep 2026). A Bulk Transaction Inquiry endpoint exists for Egypt payouts — [Beyond Payments](https://developers.paymob.com/paymob-docs/beyond-payments), [Bulk Transaction Inquiry](https://developers.paymob.com/egypt/payouts/bulk-transaction-inquiry-api-endpoint). A separate payouts portal (payouts.paymobsolutions.com, Swagger + token refresh) is listed in an aggregator index only — [api-evangelist index](https://raw.githubusercontent.com/api-evangelist/paymob/refs/heads/main/apis.yml) (unverified)
- Paymob split/marketplace payments: no public documentation found in search (2026) — searches of [Paymob docs](https://developers.paymob.com/paymob-docs)
- Kashier "connected accounts": an authorized platform makes payments on behalf of other Kashier merchants by passing the sub-merchant MID as `connectedAccount.merchantId` on Payment Sessions. The sub-merchant must authorize the platform. The page covers payment, not settlement or payouts — [Kashier connected accounts](https://developers.kashier.io/docs/accept-payments/connected-accounts)
- Kashier documents a Payouts section (bank and wallet disbursements) and a settlement guide. I did not retrieve their details. Kashier serves Egypt-located businesses only — [Kashier docs](https://developers.kashier.io/docs), [Kashier FAQ](https://kashier.io/en/faqs)
- FawryPay: two server-callback APIs fire on status change and require an acknowledgement. There is also a pull "Get Payment Status" (GET with merchantCode, merchantRefNumber, signature). Auth is a merchant code plus a SHA-256 signature — [FawryPay staging docs](https://developer.fawrystaging.com/docs/payment-notifications/get-payment-notification), [dev.to guide](https://dev.to/_moehab/a-comprehensive-guide-to-integrate-fawrypay-api-into-your-own-restful-api-server-478d)
- Fawry status values per community libraries: NEW, PAID, EXPIRED, CANCELED, REFUNDED, FAILED, PARTIAL_REFUNDED. Callbacks are recommended over polling for pay-at-outlet reference codes — [fawrypay Packagist](https://packagist.org/packages/david-maximous/fawrypay), [fawry-node](https://github.com/fawry-api/fawry-node) (third-party)
- InstaPay: Alex Bank's app describes a "Collect request" (request-to-pay) flow limited to IPN-participating banks — [Alex Bank InstaPay](https://alexbank.com/en/retail/instapay.html). CBE planned QR payments to merchants — [Business Today Egypt](https://www.businesstodayegypt.com/amp/1/4664/InstaPay-to-allow-money-transfer-using-QR-Code-within-days) (date unclear). A transfer fee of 0.1% (min 0.50 EGP, max 20 EGP) is reported, year unclear — [Asharq](https://asharq.com/reports/120564/)
- Orchestrapay lists InstaPay among Egyptian online-checkout gateways and says ~40% of e-commerce is still COD (vendor figure, unverified) — [Orchestrapay](https://www.orchestrapay.com/coverage/africa/egypt)

### Inferences
- The default for Outlet NK should be Paymob as primary (widest method coverage including BNPL), with Kashier as secondary. Kashier's connected accounts are the only documented sub-merchant primitive, so they are a strong candidate for ADR-0003's "no pooled seller funds" requirement.
- Integrate InstaPay through a PSP (Paymob or Kashier expose it as a method), not directly with IPN. No public merchant API for direct request-to-pay was found.
- Webhook pattern is the same across all three: verify HMAC/signature, store the raw body, dedup on the event ID, and poll a status endpoint as a fallback. This matches spec §7.
- (background, unverified) Paymob uses the HMAC of concatenated callback fields with the account HMAC secret. Card tokenization with "saved card" tokens and MOTO/recurring integrations exist but need account enablement. Apple Pay and mobile wallets are separate integration IDs. Geidea offers a hosted checkout and a Meeza card acceptance product. Meeza cards are accepted by most Egyptian PSPs as a card scheme.

### Gaps
- Public fees and settlement T+n for Paymob, Kashier, Fawry and Geidea: none found in official sources in 2026. These need sales quotes.
- Paymob split/sub-merchant API, and recurring via mobile wallets: not documented publicly.
- Geidea Egypt developer docs: not researched (search budget).
- Fawry disbursement API: not found.
- No official CBE/IPN 2026 confirmation of a live merchant e-commerce request-to-pay product.
- Meeza-specific e-commerce integration details: not found.

## BNPL: direct APIs or PSP-only?

### Takeaway
The clear documented path in 2026 is through a PSP (Paymob lists valU, Sympl and Souhoola). No public direct developer APIs were found for valU, Sympl, Contact, Souhoola, Halan or Aman. Direct integrations appear to be partner contracts with private docs. The spec's "monthly amount from the provider quote API" requirement may not be supported via a PSP. VERIFY.

### Cited Findings
- valU, Sympl and Souhoola are available as Paymob methods in Egypt, enabled per merchant by the account manager — [Paymob docs](https://developers.paymob.com/paymob-docs)
- Third-party ERPNext connector describes valU/Souhoola installment selection at checkout through Paymob's Unified Intention API, reconciled by an HMAC-verified webhook (vendor marketing, unverified) — [ECOSIRE Paymob connector](https://ecosire.com/ar/apps/erpnext/erpnext-paymob-gateway)

### Inferences
- Phase 1 "1 BNPL partner" is fastest through Paymob. Refund-via-provider (spec §B3) then becomes a Paymob refund or void on that transaction. Confirm that it cascades to cancelling the loan.
- A pre-checkout "from X EGP/month" quote likely needs a direct lender integration. Hide that copy until a quote API is contracted.

### Gaps
- Direct APIs, minimum ages and marketing rules for valU, Sympl, Contact, Souhoola, Halan and Aman: no public docs found.
- Whether Kashier or Geidea route BNPL: not confirmed.

## Couriers: Bosta, Aramex, Mylerz, J&T, R2S, aggregators

### Takeaway
Bosta has official SDKs (Node, maintained by bostaapp) covering deliveries, pickups, pickup locations, AWB printing, COD amount and geo lookups (cities, zones, districts). I did not retrieve the official REST reference or the webhook spec. Other couriers and aggregators were not covered within the search budget.

### Cited Findings
- Bosta official Node SDK: pickup calls (`getBusinessPickupLocations`, create/update/get/delete pickup). An API key requires a registered business. The base URL switches between staging and production — [bostaapp/bosta-nodejs](https://github.com/bostaapp/bosta-nodejs)
- Bosta Python SDK: CRUD for deliveries and pickups, with `cod` (int) on create/update — [bostasdk PyPI](https://pypi.org/project/bostasdk/)
- Community .NET SDK: create, bulk create, track, search, terminate, print AWB. Pickup available dates. Geo cities/zones/districts. Delivery types 10 = Send, 15 = Cash collection, 25 = Return, 30 = Exchange (third-party) — [Bosta.Net](https://www.nuget.org/packages/Bosta.Net)
- Community Laravel package exposes cash-cycle details per shipment (COD status and fees) — [shippulse/laravel-bosta](https://root.packagist.org/packages/shippulse/laravel-bosta)
- Bosta tracking webhooks push status changes (third-party description) — [TrackingMore](https://www.trackingmore.com/fr/bosta-tracking-api)

### Inferences
- Delivery type 25/30 maps directly onto spec §22 return pickups and exchange-first. Use Bosta's geo endpoints as the courier-coverage table for address validation (§7).
- Build `CourierPort` with idempotency on the shipment ID, because SDK create calls show no idempotency key. Dedup on the returned tracking number.

### Gaps
- Official Bosta webhook payload and signature scheme, rate limits, COD remittance cycle: not confirmed.
- Aramex (background, unverified: SOAP/JSON "Shipping Services API" with a developer portal), Mylerz, J&T Egypt, R2S, ShipBlu and Turbo: not researched in this pass.

## Tax: ETA e-invoice and e-receipt APIs

### Takeaway
I could not reach ETA's official SDK site. The only search results were a vendor's description of an e-receipt integration: per-POS-device registration with an activation code and token lifecycle, a receipt UUID, item codes (EGS/GS1) and a QR. Signing and HSM details are unverified.

### Cited Findings
- Vendor (ECOSIRE) e-receipt app: per registered POS device registration, activation code and token; serializes each sale, computes or requests a receipt UUID, submits to the ETA e-receipt SDK, and prints a QR. Items are mapped to EGS/GS1 codes plus ETA tax type and subtype. Failed submissions are queued and retried with back-off. Price from USD 499, build-to-order (vendor, 2026) — [ECOSIRE ETA e-receipt](https://ecosire.com/apps/erpnext/erpnext-egypt-eta-ereceipt)

### Inferences
- (background, unverified) The ETA e-invoice (B2B) API uses OAuth2 client credentials per taxpayer ERP system and documents in JSON/XML. It needs a CAdES-BES signature from a USB token/HSM issued by an accredited certificate authority (e.g. Egypt Trust, MCDR). The e-receipt API uses a POS client ID and secret plus a device serial and a SHA-256 UUID chain over the canonicalized receipt, with no per-receipt token signature. There are separate pre-production and production environments (`*.preprod.invoicing.eta.gov.eg`). All of this must be confirmed at sdk.invoicing.eta.gov.eg.
- If confirmed, HAUL's B2B commission invoices need a signing service (HSM or cloud signer from an accredited CA). E-receipts for delivery fees and Plus need only a registered virtual POS. This supports an `EtaAdapter` with two sub-adapters.

### Gaps
- Official ETA SDK docs, the certified integrator list, and delegated signing for sellers: not reachable from this session.

## Messaging: SMS/OTP, WhatsApp, email

### Takeaway
Meta's official page says Egypt's utility and authentication rates were lowered from 1 Apr 2026. A third-party listing (July 2026) gives Egypt authentication at about USD 0.0036 per message plus 14% VAT. Egypt is also in the "Authentication-International" market list at about USD 0.065 for international senders. The research did not cover SMS providers.

### Cited Findings
- Meta pricing page: Egypt utility and authentication rates lowered, effective 1 Apr 2026 — [Meta WhatsApp pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing) (snippet only; the fetch was blocked)
- Egypt authentication about USD 0.0036 per message, plus 14% VAT. Authentication-International about USD 0.065 (third-party, updated July 2026) — [ChatMaxima Egypt](https://chatmaxima.com/whatsapp-api-pricing/egypt/)
- Authentication-International applies to Egypt among nine markets — [Chatalog](https://docs.chatalog.ai/platform-setup/whatsapp-connection-guide/whatsapp-pricing-update)
- Sources conflict on whether service and utility messages became chargeable from 1 Oct 2026 — [ChatMaxima](https://chatmaxima.com/whatsapp-api-pricing/egypt/) vs [Zernio](https://zernio.com/blog/whatsapp-business-api-pricing)

### Inferences
- WhatsApp OTP at about USD 0.0036 is very likely cheaper than international SMS aggregators for Egyptian numbers. This strengthens spec §1's WhatsApp fallback. The OTP must be sent from a business number registered in Egypt, or the international rate (about 18× higher) could apply. VERIFY the rule for which sender counts as international.

### Gaps
- SMS pricing and sender-ID registration for Twilio, Vonage, Infobip, Victory Link and Cequens in Egypt: not researched.
- Email provider: not researched. Residency (ADR-0002) matters for the choice.
- An exact Meta rate card in USD from the official CSV: not retrieved.

## KYC: national ID, Commercial Registry, IBAN

### Takeaway
Valify (Cairo, founded 2018) offers Egyptian national ID OCR, face match, liveness and a hosted web flow with webhooks. Whether a registry-backed match is available is unclear and appears arrangement-specific.

### Cited Findings
- Valify Egypt NID OCR API (staging v1.5, bearer auth, `document_verification_plus` option) — [Valify docs](https://valify.gitbook.io/documentation/kyc/kyc-documents/egy-nid-ocr)
- Valify web verification flow: NID OCR + face match + liveness + email/phone OTP. Configured with Valify; `X-Valify-Api-Key`; the result is sent by webhook — [Valify web flow](https://valify.gitbook.io/documentation/kyc/kyc-features/egy-nid-ocr)
- 2020 interview: Valify cross-checks the phone number against a national registry — [FinDev Gateway](https://www.findevgateway.org/interview/2020/01/can-you-get-know-your-customer-through-app)
- Competitor claim that Egypt exposes no general consumer civil-registry API (unverified) — [Didit](https://didit.me/solutions/countries/egypt/)

### Inferences
- Seller KYC (spec §19) should use Valify OCR + liveness for the signatory, plus a manual Ops check of the commercial register and tax card documents, until a registry API is confirmed. Seller onboarding should collect the IBAN and validate its checksum locally (Egypt IBAN, ISO 13616 mod-97; background knowledge). Name matching would come via the payout PSP or bank.

### Gaps
- Commercial Registry (GAFI / Ministry of Supply) online lookup API, and an IBAN name-match service in Egypt: not found.

## Mapping

### Takeaway
Not researched in this pass because the search budget was exhausted.

### Cited Findings
- None.

### Inferences
- (background, unverified) Google Maps Platform has the best Egyptian POI and Arabic coverage. HERE and Mapbox are cheaper alternatives. Courier geo endpoints (Bosta cities, zones and districts, above) should be the canonical address taxonomy, with the map pin used only as supplemental coordinates.

### Gaps
- 2026 pricing, Arabic address quality and residency implications of Google, HERE, Mapbox or local providers in Egypt.
