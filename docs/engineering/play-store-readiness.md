# Play Store readiness (Android, Phase 2 launch)

| Item | Status | Owner |
|---|---|---|
| Play Console account, identity verification, app record | Not started | Owner |
| Package name (open question 9, permanent) | Placeholder `com.outletnk.placeholder` | Owner |
| Play App Signing, upload keystore backed up | Not started (EAS generates) | Owner |
| Target API / edge-to-edge | `edgeToEdgeEnabled: true`, `allowBackup: false`, predictive back off | Eng |
| Permissions | Minimal: INTERNET (implicit), CAMERA (photos). Blocked: RECORD_AUDIO, legacy storage, SYSTEM_ALERT_WINDOW. Verify merged manifest after first build | Eng |
| App links | Intent filter + assetlinks.json only when `APP_LINK_HOST` is set; scheme `zoutlet` always | Owner/Infra |
| Closed test requirement for new personal accounts (12 testers, 14 days) | Check account type | Owner |
| Data safety form | Draft below | Owner/DPO |

## Data safety form draft (from docs/privacy/data_inventory.yaml, not counsel-reviewed)
Data is encrypted in transit (TLS); users can request deletion (in-app account deletion + web link required by Play: provide a URL). No data sold. No data shared for advertising.
| Play category | Collected | Shared (processors only: PSP, courier, SMS/WhatsApp) | Purpose | Optional |
|---|---|---|---|---|
| Phone number | Yes | Yes (SMS/WhatsApp, courier via relay) | Account, delivery | No |
| Email | Yes | Email provider | Account, receipts | Yes |
| Name, address | Yes | Courier, seller (delivery only) | Order fulfilment | No |
| User IDs | Yes | No | Account | No |
| Device or other IDs | Yes (device id, push token) | No | Security, notifications | No |
| Purchase history | Yes | Seller (own orders) | Fulfilment | No |
| Payment info | Not collected by app (PSP hosted/SDK; tokens only) | PSP | Payment | No |
| Photos | Yes, when user attaches | No | Reviews/returns | Yes |
| Date of birth / age attestation, body measurements | Yes (consent for measurements) | No (never to sellers) | Age gate, fit | Measurements optional |
| Precise location | No (only if `location_precise` consent feature ships) | | | |
| App activity / diagnostics | Only after `analytics` consent (PostHog, Sentry) | Processors | Analytics | Yes |
