# ADR-0006: Mobile foundation: Expo SDK 57, EAS cloud builds, mobile-first without a backend

- Status: **Accepted** (reversible defaults within the approved scope; owner approved the iOS-only start on 2026-10-10)
- Date: 2026-10-10
- Deciders: Founder, Tech Lead
- Spec refs: §T2, §A2, §P3 Phase 0, register row 14

## Context

The owner approved the Phase 0 package and first asked to start with the **iOS app only**. After the 2026-10-10 research round (iOS is roughly 9-12% of Egyptian mobile; see below) the owner chose **one Expo codebase targeting iOS and Android**, and to **keep the full Phase 1 scope** from the master prompt. Web apps (Seller Center, Admin) remain out of scope for now. Facts verified on 2026-10-10:

- Expo `latest` is **SDK 57** (React Native 0.86, React 19.2). Register row 14 is resolved: use SDK 57, with Hermes v1 left off until the stable release notes say otherwise (SDK 57 notes mention two Hermes v1 regressions fixed in 57.0.9 and 57.0.17).
- Apple requires uploads built with **Xcode 26+** since 2026-04-28. The development machine has Xcode 16.4, so it cannot produce store builds or, most likely, current SDK simulator builds.
- Development machine runs Node 25. The spec asks for Node LTS, which is **Node 24**.
- No backend exists yet.

## Decisions

1. **One Expo codebase for iOS and Android** (owner decision 2026-10-10). iOS remains the first store submission (TestFlight and early App Review on Plus per ADR-0004), and Android follows from the same app. Platform-specific code is isolated behind adapters. **Expo SDK 57**, New Architecture, Expo Router, TypeScript strict flags from §A2.1.
2. **Builds run on EAS cloud** (current Xcode image). Local machine is used for typecheck, lint, unit tests and Expo dev server. Testing on a device uses a development build or Expo Go.
3. **Node 24 LTS** pinned with `.nvmrc` and `engines`. pnpm is pinned through `packageManager`.
4. **Mobile-first, backend-later via ports.** The app depends on interfaces in `packages/domain` (for example `AuthPort`, `CatalogPort`). Phase 0 ships in-memory fakes that return only **clearly synthetic** data. No fabricated stock, reviews, timers or discounts are ever shown as real (§A2.13), so fakes are labelled as development fixtures and disabled in release builds.
5. **No real personal data** anywhere until ADR-0002 is accepted. SDKs such as PostHog and Sentry are not initialised in this milestone.
6. **Arabic-first with RTL** from the first screen. CI fails when an Arabic key is missing (§A2.15).

## Consequences

- Cannot run an iOS simulator locally on this machine until Xcode is upgraded. EAS builds cost build minutes and queue time.
- The fakes must be replaced by generated API-client adapters once the API contract exists. Ports make this a swap, not a rewrite.
- Hermes v1 and the pinned SDK should be re-checked at each SDK upgrade.

## Known spec contradictions to resolve as we reach them

The owner chose to keep the full Phase 1 scope. A scope review on 2026-10-10 found internal contradictions in the master prompt that must be settled by ADR before the affected module is built, not worked around silently:

- Launch checklist (§P1) requires a 72-hour Mega Drop and creators, while drops are Phase 2 and creators Phase 3 (§P3).
- Refund deadline: 14 days from delivery (§B5) versus 14 days from return receipt (§15.6).
- Per-store 2,000 EGP free-delivery threshold (§6) conflicts with the one-bag promise until hub consolidation exists (Phase 2).
- Store credit sits in Phase 1 checkout while gift cards and the wallet's legal status are unresolved (open questions 3 and 4).
- Reservation TTL of 10 minutes (§7) versus 30-minute wallet and 24-hour Fawry holds.
- Plus is 21+ by default while the target audience skews 18-24.
- Price integrity needs history that one-off clearance SKUs mostly lack (§9.3), so the "was price" evidence rule needs a decision.
