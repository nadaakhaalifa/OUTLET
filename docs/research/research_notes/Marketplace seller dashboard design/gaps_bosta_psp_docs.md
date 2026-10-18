# Gaps: Bosta, PSP (Paymob, Kashier, Fawry), Aramex official docs

Fetch status: WebFetch worked. Fetched in full: Bosta how-to pages (delivery, webhook, pickup, AWB), Kashier connected-accounts, settlement, refunds, payouts, instant-settlement. NOT fetched / failed: docs.paymob.com (TLS cert mismatch), developers.paymob.com (JS "Loading..." only; /llms.txt 404), developer.fawrystaging.com (ECONNRESET, then redirect to /public/docs not retrieved), bosta.co/pricing (title only, no content), Aramex (not attempted, budget), Bosta API reference at docs.bosta.co/api (not fetched). Facts below come from the fetch tool's page extraction.

## Bosta: delivery creation, states, webhooks, pickups, AWB

### Takeaway
Bosta docs give exact order type codes, 23 numeric state codes, exception (NDR) codes, webhook payload fields, pickup and AWB endpoints. COD remittance cycle and fees were not found in the pages fetched.

### Cited Findings
- Order types/codes: Deliver `10`, CRP (Customer Return Pickup) `25`, Cash Collection `15`, Exchange `30` — [Create first delivery](http://docs.bosta.co/docs/how-to/create-your-first-delivery/)
- Endpoints: single `POST https://app.bosta.co/api/v2/deliveries?apiVersion=1`; bulk `POST https://app.bosta.co/api/v2/deliveries/bulk?apiVersion=1` — same page
- `specs.packageType`: Small, Medium, Large, Light Bulky, Heavy Bulky; `specs.packageDetails.description`, `itemsCount` — same page
- COD: required for Cash Collection (error 3006); max 30,000 EGP (3007); CRP accepts only refund COD (3005), also capped 30,000 (3008); for prepaid-in-part, `escrowInfo.amountToBeCollected` holds prepaid amount while `cod` holds full order value — same page
- `dropOffAddress` required for Deliver/Exchange; `pickupAddress` required for Cash Collection/CRP; `businessLocationId` pickup or return location (default used if omitted); `goodsInfo` needed for insurance; `allowToOpenPackage` true requires `deliveryImages` type `ALLOW_TO_OPEN_THE_PACKAGE` with 1–10 URLs (else 2150) — same page
- Error codes 1073 (business location required), 2150, 2151, 2152, 3001–3004 (city/zone/district/street not found), 3009 — same page
- Webhook set up in Dashboard Settings > API Integration (OTP, URL, optional Authorization key) or per order via `webhookUrl` and `webhookCustomHeaders`; fires only on status change, not creation — [Webhook](http://docs.bosta.co/docs/how-to/get-delivery-status-via-webhook/)
- Webhook payload fields: `_id`, `trackingNumber`, `state` (number), `type` (SEND, EXCHANGE, CUSTOMER_RETURN_PICKUP, RTO, SIGN_AND_RETURN, FXF_SEND), `cod` (sent only in Delivered), `timeStamp`, `isConfirmedDelivery`, `deliveryPromiseDate` (DD-MM-YYYY), `exceptionReason`, `exceptionCode` (Exception state only), `businessReference`, `numberOfAttempts` — same page
- State codes: 10 Pickup requested; 11 Waiting for route; 20 Route assigned; 21 Picked up from business; 22 Picking up from consignee; 23 Picked up from consignee; 24 Received at warehouse; 25 Fulfilled; 30 In transit between hubs; 40 Picking up (cash collection); 41 Picked up; 45 Delivered; 46 Returned to business; 47 Exception; 48 Terminated; 49 Canceled; 60 Returned to stock; 100 Lost; 101 Damaged; 102 Investigation; 103 Awaiting your action; 104 Archived; 105 On hold — same page
- Meaning varies by type: 41 = out for delivery (SEND) vs out for return (CRP, RTO, EXCHANGE); 22 = out for pickup (CRP) / out for exchange (EXCHANGE) — same page
- 48 Terminated sent after three failed attempts to pick up a return or collect cash; 103 Awaiting your action sent after three failed return attempts due to a return exception — same page
- Forward exception codes: 1 customer not at address, 2 address changed, 3 postponed by customer, 4 customer wants to open shipment, 5 data modification (address/phone), 6 sender requested cancel, 7 customer not answering, 8 customer refuses, 12 outside coverage, 13 address unclear, 14 wrong phone, 100 bad weather, 101 suspicious consignee — same page
- Return exception codes: 20 business changed address, 21 postponed by business, 22 data modification, 23 business not answering, 24 business refused, 25 business not at address, 26 order damaged, 27 empty order, 28 incomplete, 29 not belonging to business, 30 opened when should not, 100, 101 — same page
- Pickup: `POST https://app.bosta.co/api/v2/pickups`; fields `scheduledDate` (YYYY-MM-DD), `businessLocationId`, `contactPerson{name,phone,secPhone,email}`, `notes`, `numberOfParcels`, `packageType` (Normal, Light Bulky, Heavy Bulky), `repeatedData{repeatedType One Time|Daily|Weekly, days, startDate, endDate}`; errors incl. 1080 (Friday not allowed), 1081 (cut-off passed), 1078 (pickup already exists) — [Create first pickup](http://docs.bosta.co/docs/how-to/create-your-first-pickup/)
- AWB: `POST https://app.bosta.co/api/v2/deliveries/mass-awb`; `trackingNumbers` (comma string), `requestedAwbType` A4 or A6, `lang` ar/en; max 1,000 per request; <=50 returns base64 PDF, >50 emailed zip of 100 per file; CRP, Cash Collection and finished orders not printable — [Print AWBs](http://docs.bosta.co/docs/how-to/print-awbs/)
- Bulk creation endpoint exists (above); how-to index also lists API key, auth token, pickup location, address format (zoning sheets), IP whitelisting — [How-to index](http://docs.bosta.co/docs/category/how-to/)

### Inferences
- A seller dashboard can map state 45 to Delivered (COD amount known only there), 47 plus `exceptionCode` to NDR queue, 103 to a seller action-required queue, 46/60 to return received.
- The Bosta webhook is unsigned per the page (only an optional Authorization key), so the endpoint needs its own authenticity and dedup controls.

### Gaps
- COD remittance / cash-out cycle and COD fees: not found; bosta.co/pricing returned only a title. Needs docs.bosta.co/api or help center, or contract.
- Webhook retry/timeout/expected response: page says not documented.
- RTO and exchange flow detail beyond type codes and states: not fetched (API reference not read).
- Order-level cancel/edit endpoints: not fetched.

## PSPs: sub-merchant / split / payout / KYC / settlement / refund

### Takeaway
Only Kashier docs were readable. Kashier has a Payouts API (to bank, card, wallet), Connected Accounts (platform pays on behalf of merchants), settlement windows and refunds. Paymob and Fawry primary docs were not retrievable.

### Cited Findings
- Kashier Connected Accounts: authorized platforms make payments on behalf of other Kashier merchants; platform must be an existing Kashier merchant; connected account must be a live-enabled Kashier merchant and authorize the platform by showing its payment UI in the platform's app; payment uses `connectedAccount.merchantId` with `MID-` prefix in Payment Sessions; both sides see transactions in Merchant Portal — [Kashier connected accounts](https://developers.kashier.io/docs/accept-payments/connected-accounts)
- That page does not describe onboarding steps, required documents, split configuration or licence notes — same page
- Kashier Payouts: send from Kashier balance to bank accounts, cards, mobile wallets (vendors, suppliers etc.); `accountId` format `ACC-`; beneficiaries saved via `partyId`/`saveBeneficiary`; methods lowercase (bank, wallet, instant wallet, card, octo card, internal account); wallet max 60000; 1–1000 transfers per batch; `merchantTransferId` unique and required for webhooks; fee inquiry `POST /v2/transfers/fee-inquiry` — [Kashier payouts](https://developers.kashier.io/docs/payouts)
- Payout statuses: PENDING, INITIATED, IN_TRANSIT, TRANSFERRED (final unless `openForReturn`), FAILED (balance reversed); no durations given — same page
- Kashier settlement windows: `windowId` (STW-...), statuses `open`, `in_progress`, `closed`, `failed`; `totalOriginalAmount` gross vs `totalSettlementAmount` net of fees and VAT; no T+n stated; live only — [Kashier settlement](https://developers.kashier.io/docs/accept-payments/settlement)
- Kashier instant settlement: off by default, only Kashier can enable; fee = rate fees + VAT + flat; statuses PENDING, PROCESSING, TRANSFERRED, DECLINED; caps `perRequestCap`, `dailyCap` — [Instant settlement](https://developers.kashier.io/docs/payouts/instant-settlement)
- Kashier refund: `PUT https://fep.kashier.io/v3/orders/:orderId` with `apiOperation` `REFUND` (or `VOID`); omit `transaction.amount` for full, send for partial; cannot exceed original; paid from available balance (not pending); no time limit stated; statuses SUCCESS, FAILURE, PENDING — [Kashier refunds](https://developers.kashier.io/docs/accept-payments/refunds)

### Inferences
- Kashier pages show technical capability for platform-pays-on-behalf and payouts but state nothing about the licence basis for paying third-party sellers; this stays a counsel/contract item.

### Gaps
- Paymob: disbursement, sub-merchant, split, KYC, refund, settlement — not fetched (cert error, JS-only portal, llms.txt 404).
- Fawry: refund, payouts, marketplace — not fetched (connection reset; redirect to http://developer.fawrystaging.com/public/docs not followed).
- Sub-merchant KYC documents for any PSP: not documented in fetched pages.
- Settlement T+n for any PSP: not found (Kashier page gives none).
- Licence under which split/payout to sellers is permitted: not found in any official page.

## Aramex

### Takeaway
Not researched.

### Cited Findings
- None.

### Inferences
- None.

### Gaps
- Aramex shipping API states, COD: not fetched (tool-call budget).
