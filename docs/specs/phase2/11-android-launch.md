# Spec 11: Android launch checklist

Refs: §P3 Phase 2 ("Android launch", +6-8 weeks after iOS stable), §T2, ADR-0006, ADR-0026. Not a feature spec; an exit checklist with owners.

## Flow / scope
Same Expo app and codebase; Android-specific work only. Release gate: iOS stable for >= 4 weeks with crash-free >= 99.8%.

## Rules (checklist)
| Area | Requirement |
|---|---|
| Platform | Expo SDK per ADR-0006, New Architecture, Android 16 edge-to-edge handled, target API per Play policy at release date (VERIFY) |
| Push | FCM via Expo; notification channels (transactional, marketing, drops) with user-controllable importance; POST_NOTIFICATIONS runtime permission after value screen; quiet hours 23:00-09:00 Cairo server-side |
| Attestation | Play Integrity (standard request, nonce per action) on OTP, checkout, drops, gift-card redeem, referral; fail policy: degrade to stricter limits, not hard block, for `MEETS_BASIC_INTEGRITY` only devices; server verification and replay protection |
| Payments | PSP native SDK in own view; `FLAG_SECURE` on payment screens; Apple Pay absent: Google Pay if PSP supports (VERIFY), else cards/wallets/InstaPay/Fawry/COD; BNPL provider deep-links verified |
| Billing | No Play Billing needed for physical goods and Plus under Plan A; verify Google Play payments policy for Plus (new VR-P2-05) |
| Storage/security | Keystore-backed SecureStore, no backups of tokens (`allowBackup` rules), cert pinning with >= 2 backup pins + remote kill switch, root/jailbreak signals as risk input only |
| Deep links | Verified App Links (assetlinks.json), param validation |
| Data safety | Play Data safety form generated from `data_inventory.yaml`; privacy policy URL; account deletion in-app and web URL (Play requirement) |
| RTL/i18n | RTL mirroring, font fallback IBM Plex Sans Arabic, numerals preference |
| Performance | Cold start budget on a low-end reference device (2 GB RAM class), JS bundle < 6 MB, Hermes; Macrobenchmark baseline profiles |
| Accessibility | TalkBack AR/EN, 48 dp targets |
| Testing | Maestro on Android emulators + device farm; Pact unchanged; staged rollout 1% -> 10% -> 50% -> 100% with crash-rate gate; EAS Update channels per environment |
| Store | Closed testing track, pre-launch report clean, content rating, age 18+ declaration, Play listing AR/EN |

## Edge cases
OEM battery killers delaying push (Xiaomi/Oppo) -> in-app inbox fallback + guidance; split APK/AAB size; tablets/foldables layout; no Google Play Services devices (Huawei) -> unsupported at launch, documented; WebView version differences for PSP pages.

## Data / API
No new tables beyond `devices.attest_status` values for Play Integrity verdicts (`play_basic`, `play_device`, `play_strong`) and `push_token.provider = fcm`. No new endpoints; attest verification endpoint accepts `platform=android`.

## Events / metrics
Same taxonomy with `platform` property. Metrics: crash-free >= 99.8%, ANR rate < Play bad-behaviour threshold, checkout success parity with iOS within 0.5 pt, push delivery rate.

## Failure handling
Play Integrity API quota/outage -> grace policy (stricter limits, server flag `attest_degraded`); FCM failure -> in-app inbox + SMS for transactional only.

## Security and abuse
Android-specific: tapjacking (`filterTouchesWhenObscured`), overlay detection on payment, intent redirection hardening, MASVS v2 mapped tests on Android, exported components audit.

## Acceptance
```
Given a device failing Play Integrity strong verdict, Then OTP and checkout still work under stricter limits and drops require strong verdict.
Given the payment screen, Then screenshots are blocked (FLAG_SECURE).
Given Android 16, Then no content is obscured by system bars in AR RTL.
Given staged rollout at 10% and crash rate regression > threshold, Then rollout halts automatically.
```
