# App Store readiness (iOS)

| Item | Status | Owner | Notes |
|---|---|---|---|
| Apple Developer account, App Store Connect record | Not started | Owner | Needs final bundle id (open question 9) |
| Privacy manifest (PrivacyInfo.xcprivacy) | Configured in `app.config.ts` `ios.privacyManifests`; not yet verified in a native build | Eng | Required-reason APIs: UserDefaults CA92.1, FileTimestamp C617.1/0A2A.1, SystemBootTime 35F9.1, DiskSpace E174.1/85F4.1 (RN/Expo runtime). Re-check against third-party SDK manifests after the first EAS build (Xcode privacy report) |
| Tracking | NSPrivacyTracking=false, no ATT, no NSUserTrackingUsageDescription | Eng | Re-open if any ads SDK is added |
| Privacy nutrition labels | Draft: `docs/compliance/app-privacy-labels.md` | Owner/DPO | Generated from `data_inventory.yaml` (DRAFT_NOT_REVIEWED_BY_COUNSEL) |
| Permission strings AR/EN | Done (camera, photo library, photo add) | Eng | `apps/mobile/locales/*.json`; Face ID not used so not declared |
| Account deletion in-app (5.1.1(v)) | Spec only; verify the screen exists before submission | Eng | |
| Sign in with Apple (4.8) | Verify in-app before submission | Eng | |
| Plus billing under 3.1.5(a) / 3.1.1 | ADR-0004 Plan A; unresolved with Apple | Owner/Product | Submit early via TestFlight; VERIFY row 10 |
| Export compliance | `usesNonExemptEncryption=false` | Owner | Confirm |
| Universal links | Placeholder `APP_LINK_HOST`; AASA file must be hosted on that domain | Owner/Infra | |
| Demo reviewer account | Not created | Eng | See eas.md |
| Age rating | Draft answers in eas.md | Owner | |
| Screenshots, AR/EN metadata | Not started | Design/Owner | |
| Build requires Xcode 26+ | EAS cloud only (local Xcode 16.4) | Eng | |
