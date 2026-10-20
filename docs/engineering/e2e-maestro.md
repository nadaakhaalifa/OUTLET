# E2E with Maestro (iOS first, Android from Phase 2)

Spec: master prompt A2.10 (Maestro on iOS, Android from Phase 2). Flows live in `apps/mobile/.maestro/`.

**Status: authored and YAML-syntax-validated only. No flow has been executed** (no simulator or Maestro binary was available). Treat every selector as unverified until a first green run on a simulator.

## Layout
| Path | Purpose |
|---|---|
| `.maestro/flows/01..08-*.yaml` | Runnable flows |
| `.maestro/subflows/*.yaml` | Reusable steps (onboard, add to bag, open bag, checkout) |
| `.maestro/env/en.env`, `ar.env` | Locale strings, copied from `packages/i18n` (key parity checked) |
| `.maestro/env/fixtures.env` | Synthetic fixture ids, phone, OTP, DOB |
| `.maestro/run.sh` | `run.sh <en|ar> <device> [tags]` builds `-e` args and runs |

## Flows index
| # | Flow | Tags | Spec |
|---|---|---|---|
| 01 | Onboarding age gate (under-18 refused, 18+ ok) | smoke, critical | Part C 1 |
| 02 | World switch persists across restart | smoke | Part C 3 |
| 03 | Search, PDP, add to bag | smoke, critical | Part C 4-6 |
| 04 | Free delivery 1,950 + 60 EGP | critical | Part C 6 |
| 05 | Checkout duplicate tap, network drop and resume | critical | Part C 7 |
| 06 | Return on day 15 refused with reason | critical | Part C 22 |
| 07 | Privacy deletion blockers | critical | Part C 2 |
| 08 | Arabic/RTL critical path | critical, rtl, locale-ar | A2.15 |

## Parametrization
- Locale: `run.sh ar ...` loads `env/ar.env`. Same flows, localized strings. Flow 08 should be run with `ar`; run all flows once per locale in CI.
- Device: pass the device name (used for screenshot names) and select the simulator with `maestro --device <udid>`. Matrix: iPhone SE (small), iPhone 15 (default), iPhone 15 Pro Max.
- Run subsets: `run.sh en "iPhone 15" smoke` or `critical`.

## Selector strategy
Stable `testID`s now exist for the controls below and the flows select them with `id:`. Copy-based selectors remain only where no testID exists yet (search field, PDP size chips, buttons other than checkout, return submit, consents). `testID`s are applied through `apps/mobile/src/components/TestId.tsx`, a transparent wrapper `View`, because `@outlet/ui-native` `TextField`/`Button`/`Checkbox` do not forward `testID`. Tapping a wrapper taps its centre, which lands on the control but is unverified on a device.

| testID | Where |
|---|---|
| `phone-input`, `otp-input`, `dob-input`, `dob-attest` | onboarding |
| `tab-home`, `tab-explore`, `tab-stylist`, `tab-bag`, `tab-me` | tab bar (`tabBarButtonTestID`) |
| `me-row-<orders|wallet|budget|wishlists|sizeProfile|plus|rewards|giftCards|privacy|help|settings>` | Me menu |
| `world-<local|global|everything|myStores>` (selected state) | worlds picker |
| `bag-free-delivery-bar`, `bag-free-delivery-progress` (not yet unlocked), `bag-free-delivery-unlocked`, `bag-checkout` | bag |
| `checkout-place-order` | checkout |
| `order-row-<id>` | orders list (flows match `order-row-.*`) |
| `returns-reason-<code>` | returns |
| `privacy-delete-blocker-<orders|returns|disputes>` | privacy center |

## CI snippet (GitHub Actions, macOS runner)
```yaml
e2e-ios:
  runs-on: macos-14
  strategy:
    matrix:
      locale: [en, ar]
  steps:
    - uses: actions/checkout@v4
    - uses: pnpm/action-setup@v4
    - run: pnpm install --frozen-lockfile
    - run: curl -fsSL "https://get.maestro.mobile.dev" | bash && echo "$HOME/.maestro/bin" >> $GITHUB_PATH
    - run: pnpm --filter mobile exec eas build --platform ios --profile e2e --local --output app.tar.gz
    - run: |
        xcrun simctl boot "iPhone 15" || true
        mkdir app && tar -xzf app.tar.gz -C app
        xcrun simctl install booted app/*.app
    - run: apps/mobile/.maestro/run.sh ${{ matrix.locale }} "iPhone 15" critical
```
For EAS Workflows, run the same `run.sh` in a `maestro` job type against the `e2e` build profile. The `e2e` profile must build a simulator binary against a staging API seeded with synthetic data only.

## Gaps and needs
1. **Seed/fixtures**: a staging seed providing PRODUCT_ID, PRODUCT_60_ID (60 EGP, same store as a 1,950 EGP bag line), RETURN_LINE_DAY15 (delivered 15 days ago), an account with open order, return and dispute, and pre-saved address and payment method for checkout. Flows 04-07 assume per-run seeded accounts; today they sign in as a fresh user, so they need a seed hook keyed on ADULT_PHONE.
2. **OTP**: sandbox OTP provider accepting `OTP_CODE` for e2e phones.
3. **Fault injection**: link `zoutlet://__e2e/drop-next-checkout-response` (build-profile gated, absent in production) for flow 05. Maestro cannot toggle simulator networking on iOS.
4. **testIDs**: added (see Selector strategy), still unverified on a device. Remaining copy-coupled selectors are listed there.
5. Unverified assumptions: `zoutlet://search|orders|returns|checkout|product/<id>|privacy-center` resolve through Expo Router paths (they match `src/app` files); the world picker exposes a selected state; payment method pre-selection; Maestro text matching on `TextField` labels.
6. Android flows are not included (Phase 2).
