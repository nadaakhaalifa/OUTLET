# Deliberate deviations from the master prompt

`docs/haul-master-prompt-v3.md` is not edited. This file lists every deviation the owner has decided so far. Where the master prompt and this list differ, this list wins for the item named, and the ADR is the record. Status values: Decided (owner), Decided with legal points Proposed, Proposed (owner decision pending).

| Master prompt reference | Master prompt says | Deviation | ADR / spec | Status |
|---|---|---|---|---|
| Section 7 (checkout, "Flow (one page)") | One-page checkout | Three step pages: Delivery, Payment, Review, with a sticky summary showing every fee on the first render. Saga, idempotency and quote/commit contracts unchanged | ADR-0053; `docs/specs/mobile-ux-round-2.md` section 1 | Decided (owner request, presentation only) |
| Section 6 (bag, "Guest bag is not supported: an account is required (18+ gate)") | Account required for a bag | Guest browsing with a device-only bag; the account is requested only at the Checkout gate. No guest server writes except the post-sign-up merge | ADR-0055; `docs/specs/guest-browsing.md`; VR-GUEST-01..05 | Decided (direction); legal points Proposed; `flag.guest_browsing` blocked in production |
| Section 1 (identity, onboarding order: DOB and 18+ attestation first) | Account-first onboarding before browsing | Region, then entrance page, then browsing; account creation (DOB, 18+, OTP, consents) only at Checkout | ADR-0055 | Decided (direction); legal points Proposed |
| Section 8 (wishlists, server-side lists needing an account) | Wishlists tied to the account | Guests save items on the device (expo-sqlite) and merge to the account at checkout sign-up (larger quantity wins; overflow to Saved) | ADR-0055; VR-GUEST-02 | Decided (direction); legal points Proposed |
| Section B6 row 1 (account, browse, wishlist, cart need 18+ by DOB) | Age check gates browsing, wishlist and cart | The 18+ attestation moves to the Checkout gate; browsing shows an 18+ notice only. An under-18 block at account creation stays | ADR-0055; VR-GUEST-01 | Decided (direction); counsel review Proposed |
| Section 1 / 3 (first run goes to onboarding; the region choice is not specified) | No first-launch region screen | Region selection on first launch only, changeable in Settings; only Egypt is selectable, others show "Not available yet" and no data is collected | ADR-0055; `docs/specs/guest-browsing.md` F1; VR-REGION-01 | Decided (owner rule); legal points Proposed |
| Section 0 (platforms and tabs: Home, Explore, Stylist, Bag, Me) | Home, Explore, Stylist, Bag, Me | Bottom tabs Home, Discover, Saved, Bag, Profile | ADR-0044 | Decided (owner, 2026-10-15) |
| Section 25 / T2 (iPhone first; iPad not mentioned) | iOS app on iPhone | iPad layout work: 1.725x width-based zoom, text cap 2 x zoom, bespoke entrance page. `supportsTablet` not decided and stays off | ADR-0054; `docs/specs/ipad-adaptation.md`; VR-IPAD-01 | Zoom, cap and scope decided; iPad support Proposed |
| Section 11 / T12 (external LLM provider behind `llm-gateway`) | External hosted LLM allowed through the gateway | Own AI and ML, no external hosted AI vendor (owner preference; would amend ADR-0025) | ADR-0051; VR-AI-01..06 | Proposed (owner preference) |

## Notes
- The first six rows change a customer-facing flow; the others are product or technology scope.
- ADR-0051 is an owner preference, not yet a decision.
- Update this file in the same change as any new ADR that overrides the master prompt.

## Pending owner decisions that may deviate from the master prompt
- **Seller subscription tiers.** The master prompt has no seller plans (one commission model, Seller Center section 19). ADR-0056 (Proposed) and `docs/specs/brand-and-owner-operating-model.md` propose data-driven seller plans with typed entitlements and a brand lifecycle. If the owner accepts decisions D1-D12, add a row to the table above. Nothing is built.
