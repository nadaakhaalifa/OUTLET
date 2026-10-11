# ADR-0026: Android push and attestation differences

- Status: **Proposed**
- Date: 2026-10-11
- Deciders: CTO, Mobile lead, Security
- Spec refs: §T2, B7, Phase 2 spec 11

## Context and problem statement
iOS uses APNs and App Attest; Android uses FCM and Play Integrity, with different trust levels, OEM push killers and non-GMS devices.

## Considered options
1. **FCM via Expo + Play Integrity standard requests, verdict-tiered limits (degrade, not block).**
2. Strict hard-block on anything below strong integrity.
3. Third-party push/attestation (OneSignal, Firebase App Check only).

## Decision (proposed default)
Option 1. Verdict tiers: strong = full access incl. drops; device = full except drops/gift-card redeem need strong; basic = stricter rate limits and COD/prepaid caps; fail = OTP only with extra factor. Per-action nonce, server verification, replay cache. Push: three channels, in-app inbox fallback, SMS only for transactional. Non-GMS devices unsupported at launch. Hard-blocking (option 2) rejected because many legitimate low-end/rooted-by-OEM devices in Egypt would be excluded; option 3 adds a processor with no gain.

## Consequences
Good: broad reach with abuse control; one codebase. Bad: more risk-model tuning; Android drops weaker bot signal, mitigated by device graph and limits.

## Owner decision required
None blocking; confirm tier thresholds with Security.

## Safe default if no answer
Option 1.
