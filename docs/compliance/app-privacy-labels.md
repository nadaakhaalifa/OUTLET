# App Store privacy nutrition labels (draft)

Source: `docs/privacy/data_inventory.yaml` (status DRAFT_NOT_REVIEWED_BY_COUNSEL). Must be re-derived after counsel review and after each new SDK. "Tracking": none (no cross-app tracking, no data broker sharing, no ATT).

All types below are linked to the user and used for App Functionality only unless noted.
| Apple data type | Source in inventory | Notes |
|---|---|---|
| Contact Info: Phone Number | users.phone_e164 | Sign-in, delivery |
| Contact Info: Email Address | users.email | Apple relay valid |
| Contact Info: Name, Physical Address | addresses, delivery_snapshots | Orders |
| Identifiers: User ID, Device ID | users.id, devices | Security, push |
| Purchases: Purchase History | order_* tables | |
| User Content: Photos, Other User Content | reviews, returns, stylist/style profiles | Optional |
| Other Data Types | DOB/age attestation, size measurements | Measurements need consent; never shown to sellers |
| Usage Data / Diagnostics | PostHog, Sentry | Only after consent; Analytics purpose; declare once enabled in the build |
| Location | Not collected | Add only if `location_precise` ships |
| Financial Info | Not collected by us (PSP tokens only) | Re-check with the PSP SDK's own manifest |
The `NSPrivacyCollectedDataTypes` array in `app.config.ts` mirrors this table (without diagnostics/usage, because they are consent-gated and no SDK is installed in the app yet). Keep both in sync.
