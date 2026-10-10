# Threat model: mobile app (Expo, iOS first, Android from the same codebase)

Status: Draft for review · Date: 2026-10-10 · Method: STRIDE per element · Spec refs: §T2, §B7, §B8, ADR-0006, ADR-0007 · Modules: `apps/mobile`, `ui-native`, `i18n`

## What exists in the repo today
- Expo SDK 57 app shell with tabs (`apps/mobile/src/app`), Arabic-first i18n (`packages/i18n`), design tokens.
- `expo-secure-store` is a declared dependency and an enabled config plugin (`apps/mobile/package.json`, `apps/mobile/app.json`) but no source file imports it yet.
- No networking, no API client, no analytics or crash SDK initialised (ADR-0006 decision 5).
- `apps/mobile/app.json` carries placeholder bundle identifiers (`com.outletnk.placeholder`) pending open question 9.
- Development fixtures must be excluded from release builds (ADR-0006 decision 4); the exclusion is not enforced by code yet.

## Scope and assets
Access and refresh tokens on device, cached catalog and order data (TanStack Query persistence, MMKV), push token, deep links, payment screens (PSP SDK in own view), on-device budget and size data (P3), OTA updates (EAS Update).

## Threats and controls
| ID | STRIDE | Threat | Control | Proving test | Status |
|---|---|---|---|---|---|
| MOB-S1 | S | Repackaged or tampered app talks to the API | App Attest and Play Integrity on OTP, checkout, drops, gift-card redemption and referral attribution; server verification; attestation is a signal with graceful degradation | MOB-T01 server rejects attested routes without valid assertion (see AUTH-S8) | planned |
| MOB-S2 | S | Malicious app or link hijacks deep links or the URL scheme | Universal links and app links with verified domains; custom scheme `outletnk` carries no tokens; parameters validated by Zod | MOB-T02 deep link fuzz: malformed and hostile parameters open a safe screen and never authenticate | planned |
| MOB-T1 | T | Man-in-the-middle with a rogue CA or hostile network | TLS 1.2+ only; certificate pinning policy decided in ADR-0007 (Proposed); ATS defaults not weakened | MOB-T03 proxy with untrusted CA fails closed; pin-set rotation test in staging | planned |
| MOB-T2 | T | Over-the-air update delivers malicious or broken code | EAS Update with code signing, channels per environment, staged rollout 1% to 100% with automatic rollback on crash regression | MOB-T04 update with a bad signature is rejected by the runtime in a test build | planned |
| MOB-R1 | R | User denies placing an order from a device | Order and consent events carry device ID and request ID server-side | MOB-T05a see PAY-R1; mobile sends device ID header (contract test) | planned |
| MOB-I1 | I | Tokens or personal data at rest on a lost or backed-up device | Tokens only in SecureStore/Keychain with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`; MMKV encrypted instance for cache; no P3 in non-encrypted storage; excluded from iCloud backup where applicable | MOB-T06 storage audit test lists every key and asserts class and store; SecureStore usage is the only token path | planned |
| MOB-I2 | I | Sensitive screens leak through screenshots, app switcher or screen recording | `FLAG_SECURE` on payment and sensitive screens (Android), blur on iOS app-switch | MOB-T05 on-device (Maestro or manual MASTG check) screenshot of payment screen is blank or blurred | planned |
| MOB-I3 | I | Secrets or PII in logs, crash reports or bundle | No secrets in the bundle (public config only); logger redaction; Sentry and PostHog only after matching consent | MOB-T07 bundle secret scan in CI; MOB-T08 no network call to analytics with consent off | planned |
| MOB-I4 | I | Clipboard, keyboard cache or autofill leak of OTP or card details | OTP field uses one-time-code autofill semantics and clears; payment fields live in the PSP view | MOB-T09 manual MASTG check recorded before release | planned |
| MOB-D1 | D | A stale pin or bad update bricks the app during a drop | Backup pins and remote kill switch (ADR-0007); staged rollout and rollback; offline-tolerant cache | MOB-T10 kill-switch simulation restores connectivity without a store release | planned |
| MOB-D2 | D | Fixture adapters shipped to production show fake stock or prices | Dev fixtures labelled and compiled out of release builds; CI asserts the release bundle lacks fixture module markers | MOB-T11 release build fails CI if a fixture marker is present | planned |
| MOB-E1 | E | Rooted or jailbroken device lifts protections | Detection used as risk signal (step-up, lower limits), not as a sole control; no secrets rely on device integrity | MOB-T12 risk signal increases step-up requirement in a test harness | planned |
| MOB-E2 | E | Third-party SDK exceeds permissions or exfiltrates data | SDK inventory with justification, consent gating, minimal permissions in `app.json`, SBOM per build | MOB-T13 permission manifest diff check in CI | planned |

## Residual risk
Client-side controls are advisory; the server remains the enforcement point for price, stock, age and authorization.
