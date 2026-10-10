# MASVS v2 mapping: control groups to tests

Status: Draft for review · Date: 2026-10-10 · Spec refs: §T2, §T5, ADR-0006, ADR-0007 (Proposed) · App: `apps/mobile` (one Expo codebase for iOS and Android)

## Scope and honesty rules

- **Standard.** OWASP MASVS v2 with its eight control groups: STORAGE, CRYPTO, AUTH, NETWORK, PLATFORM, CODE, RESILIENCE, PRIVACY. The exact MASVS minor version and the MASTG test-case IDs must be confirmed against the published documents before the Phase 1 security gate; the master prompt records that the current minor version was not sourced. **VERIFY BEFORE LAUNCH.** Control IDs below use the MASVS-GROUP-n form and the control wording is paraphrased.
- **Verification level.** MASVS defines the controls; MAS profiles (L1 baseline, L2 defense in depth, R resilience) are applied as follows: L1 for everything, L2 for payment, tokens and personal data handling, R (resilience) only as risk signals because the app holds no secret that device integrity could protect (see `docs/security/threat-models/mobile-app.md`).
- **Status vocabulary.** `planned`, `partial`, `implemented` as in `asvs-5.0-matrix.md`. Only repository evidence counts.
- **State of the app on 2026-10-10.** `apps/mobile` is an Expo SDK 57 shell with tabs, Arabic-first i18n and design tokens. `expo-secure-store` is declared in `apps/mobile/package.json` and enabled as a config plugin in `apps/mobile/app.json`, but no source file imports it. There is no networking layer, no API client, no payment SDK, no analytics or crash SDK (ADR-0006 decision 5). Bundle identifiers are placeholders. Therefore **no MASVS control is `implemented`**; most are `planned` because the surface they protect does not exist yet.
- **Where tests run.** Automatable checks run in CI against the JS bundle and the build config (secret scan, permission diff, fixture-marker scan, storage audit). Device-behaviour checks (screenshots, app switcher, clipboard, root and jailbreak signals) are manual MASTG checks recorded per release candidate, or Maestro flows on EAS builds. The development machine cannot run an iOS simulator for SDK 57 (ADR-0006), so device checks run on EAS builds and physical devices.

## STORAGE

| Control | Requirement (paraphrased) | Z-OUTLET control | Test | Status |
|---|---|---|---|---|
| MASVS-STORAGE-1 | Sensitive data is stored securely on the device | Access and refresh tokens only in SecureStore (Keychain, Keystore) with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`; MMKV encrypted instance for cache; no P3 in unencrypted storage; budget and size data classed P3 | MOB-T06 storage audit lists every persisted key with its class and store and fails on an unregistered key | planned (`expo-secure-store` declared in `apps/mobile/package.json`, never imported) |
| MASVS-STORAGE-2 | Sensitive data is not leaked through logs, backups, screenshots, keyboard cache, clipboard | Logger redaction; backup exclusion for token store; `FLAG_SECURE` and iOS app-switch blur on payment and account screens; OTP field with one-time-code semantics | MOB-T05 (screenshot and app switcher), MOB-T09 (clipboard and keyboard, manual), MOB-T07 (secret scan) | planned |

## CRYPTO

| Control | Requirement | Z-OUTLET control | Test | Status |
|---|---|---|---|---|
| MASVS-CRYPTO-1 | Strong, current cryptography appropriate to the use case | No custom primitives in the app; platform APIs only (SecureStore, attestation, WebAuthn); no encryption of server secrets on device | Static scan for hard-coded keys and homemade crypto (MOB-T07); dependency review | planned |
| MASVS-CRYPTO-2 | Cryptographic keys are managed securely | Keys live in the platform keystore or secure enclave; none shipped in the bundle; only public configuration in the app; see `crypto-inventory.md` | MOB-T07 bundle secret scan in CI with canary secret | planned |

## AUTH

| Control | Requirement | Z-OUTLET control | Test | Status |
|---|---|---|---|---|
| MASVS-AUTH-1 | Secure authentication and authorization protocols are used (server side) | OTP, Apple and Google sign-in, passkeys; 10 minute JWT, rotating device-bound refresh token; policy-enforced authorization on the server | AUTH-T01 to AUTH-T11, AUTH-T20, AUTH-T22 (server tests) | planned (identity tables only: `packages/db/migrations/0006_identity_consent.sql`) |
| MASVS-AUTH-2 | Local authentication (biometrics, device credentials) is done securely | Biometric unlock, if offered, gates access to a token already protected by the keystore; never a client-only decision; fallback to normal login | MOB-T14 (to add): biometric failure path does not reveal tokens and does not bypass server step-up | planned |
| MASVS-AUTH-3 | Sensitive operations require additional authentication | Step-up for IBAN-type changes (sellers), store-credit use on dormant numbers, export and delete; enforced by server | AUTH-T05, LED-T13, PRIV-T01 | planned |

## NETWORK

| Control | Requirement | Z-OUTLET control | Test | Status |
|---|---|---|---|---|
| MASVS-NETWORK-1 | Network traffic is secured with TLS | TLS 1.2 or higher, ATS defaults not weakened, no cleartext traffic permitted in release (Android network security config); no TLS-disabling debug flags in release | MOB-T03 proxy with untrusted CA fails closed; config assertion in CI that cleartext is not enabled | planned |
| MASVS-NETWORK-2 | The identity of the remote endpoint is verified (pinning where used) | Decision pending in `docs/adr/0007-certificate-pinning.md` (Proposed): SPKI pin set with backup pins and remote kill switch, versus CT plus App Attest | MOB-T03, MOB-T10 (kill switch restores connectivity without store release); pin rotation rehearsal in staging | planned |

## PLATFORM

| Control | Requirement | Z-OUTLET control | Test | Status |
|---|---|---|---|---|
| MASVS-PLATFORM-1 | Platform interaction (IPC, intents, URL schemes, deep links) is secure | Universal links and app links with verified domains; custom scheme `outletnk` carries no token; deep link parameters parsed with Zod and never used for authentication; minimal exported components and permissions | MOB-T02 deep link fuzz; NOTIF-T03 forged deep link; MOB-T13 permission and manifest diff in CI | planned (scheme defined in `apps/mobile/app.json`; no handlers) |
| MASVS-PLATFORM-2 | WebViews are used securely | No general-purpose WebView planned; PSP hosted pages open in a system browser session or the PSP SDK's own view; if a WebView is added, it loads only allow-listed origins with JavaScript bridges disabled | MOB-T15 (to add): grep gate in CI rejects `WebView` imports without an ADR reference | planned |
| MASVS-PLATFORM-3 | The UI does not leak sensitive data | Payment fields live in the PSP's view; masked IBAN and phone; no sensitive data in notification payloads or on lock screen; screen-capture protection on payment | MOB-T05, NOTIF-T05 | planned |

## CODE

| Control | Requirement | Z-OUTLET control | Test | Status |
|---|---|---|---|---|
| MASVS-CODE-1 | The app requires an up-to-date platform version | Minimum OS versions set by Expo SDK (SDK 57); re-evaluated each SDK upgrade | CI asserts `minimumOsVersion` equals the documented value | partial (SDK pinned in `apps/mobile/package.json`; no assertion test) |
| MASVS-CODE-2 | Updates are enforced when security-relevant | Server-side minimum app version check returning an update-required state; EAS Update with code signing and staged rollout | MOB-T04 bad-signature update rejected; forced-upgrade contract test | planned |
| MASVS-CODE-3 | Third-party components are free of known vulnerabilities | Lockfile, `pnpm audit` and OSV in CI, SBOM per build, SDK inventory with justification | SUP-T01 known-vulnerable fixture fails the build; SBOM artifact present | planned |
| MASVS-CODE-4 | Untrusted inputs are validated and sanitised | Zod at every boundary: API responses, deep links, push payloads, deserialized cache; TypeScript strict | MOB-T02; contract tests against the generated API client | planned |

## RESILIENCE

Z-OUTLET treats resilience controls as risk signals, never as the only protection: no secret depends on device integrity, and the server is the enforcement point for price, stock, age and authorization.

| Control | Requirement | Z-OUTLET control | Test | Status |
|---|---|---|---|---|
| MASVS-RESILIENCE-1 | App validates platform integrity | App Attest (iOS) and Play Integrity (Android) on OTP, checkout, drops, gift-card redemption and referral attribution; failure degrades to stricter limits | MOB-T01, AUTH-T10, AUTH-T11, MOB-T12 | planned |
| MASVS-RESILIENCE-2 | App implements anti-tampering | Release signing, EAS Update code signing; no custom obfuscation planned initially; detection of repackaging comes from attestation | MOB-T04 | planned |
| MASVS-RESILIENCE-3 | App implements anti-static-analysis | Hermes bytecode and minification by default; no claim that secrets can be hidden; none are shipped | MOB-T07 | planned |
| MASVS-RESILIENCE-4 | App implements anti-dynamic-analysis | Root and jailbreak signals as risk input only; debuggable disabled in release; no reliance on hiding | MOB-T12; release config check in CI (debuggable off) | planned |

## PRIVACY

| Control | Requirement | Z-OUTLET control | Test | Status |
|---|---|---|---|---|
| MASVS-PRIVACY-1 | Data collection and sharing is minimised | Event allow-list with PII class guard; P2/P3 never in analytics; size and budget data on device where possible | PRIV-T06; PII guard code in `packages/analytics/src/pii.ts` | partial (guard code present in `packages/analytics/src/pii.ts` and `naming.ts`, no test file yet; app does not emit analytics) |
| MASVS-PRIVACY-2 | Users cannot be identified from collected data | Pseudonymous analytics ID rotated yearly; no advertising ID; no raw coordinates; no device fingerprinting beyond attestation | PRIV-T12; MOB-T08 | planned |
| MASVS-PRIVACY-3 | Data use is transparent | Consent screens versioned with content hash; privacy notice and data-use summary in Arabic and English; iOS privacy manifest and Play data-safety answers generated from `docs/privacy/data_inventory.yaml` | PRIV-T03; store-form generation check (to add) | partial (`docs/privacy/data_inventory.yaml` and `consent_text_versions` table in `packages/db/migrations/0006_identity_consent.sql`; untested) |
| MASVS-PRIVACY-4 | Users control their data | In-app consent toggles with immediate SDK gating, export and delete requests with step-up | PRIV-T01, PRIV-T05, PRIV-T09 | planned |

## Release checklist

A release candidate cannot be promoted from TestFlight or an internal track until every `MOB-T` and `AUTH-T` test listed above is green or has a written waiver signed by the Tech Lead, and the manual MASTG checks (MOB-T05, MOB-T09, MOB-T12) are recorded for the build number.

## Test IDs introduced here

| ID | Test |
|---|---|
| MOB-T14 | Biometric local-auth failure path reveals no token and does not bypass server step-up |
| MOB-T15 | CI gate rejects a `WebView` import that has no ADR reference |

All other IDs are defined in `docs/security/threat-models/`.

## Open items

1. Confirm MASVS minor version and map to MASTG test-case IDs. **VERIFY BEFORE LAUNCH.**
2. Certificate pinning decision (ADR-0007) determines the MASVS-NETWORK-2 tests.
3. Payment SDK choice (open question on PSP) determines PLATFORM-2 and STORAGE-2 specifics.
