# Visual regression

Purpose: catch silent visual decay when many people and agents edit screens. Opt-in; **not part of the default gate** (baselines are platform-sensitive).

## Web (Seller Center, Admin Console)
- Spec: `tooling/e2e/tests/visual.spec.ts`, Playwright project `visual`. It is only registered when `E2E_VISUAL=1`; the default `desktop`/`mobile` projects ignore it.
- Matrix: login + one or two authenticated pages x EN/AR x light/dark, full page, motion reduced.
- Tolerance: `maxDiffPixelRatio 0.02`, per-pixel `threshold 0.2` (set in `tooling/e2e/playwright.config.ts`).
- Baselines: `tooling/e2e/visual-baselines/visual/...` (created on first update run).

Run (apps must be up as for `run.sh`):
```
E2E_VISUAL=1 tooling/e2e/run.sh seller --project=visual            # compare
E2E_VISUAL=1 tooling/e2e/run.sh seller --project=visual --update-snapshots   # accept new baselines
```
Update baselines only in a PR that intentionally changes the look, and attach the diff images.

The existing `design.spec.ts` keeps producing the review screenshots under `docs/design-system/screenshots/`; those are not asserted.

## Mobile (Maestro)
- Flow: `apps/mobile/.maestro/flows/visual-smoke.yaml` (tag `visual`). Walks home, explore, stylist, bag, me and calls `takeScreenshot` with stable names `visual-01-home` ... `visual-05-me`.
- Run on an iOS simulator with the dev build installed:
```
cd apps/mobile
maestro test --include-tags=visual -e APP_ID=<bundle id> $(cat .maestro/env/en.env | sed 's/^/-e /') .maestro/flows/visual-smoke.yaml
# or: .maestro/run.sh en <device> visual
```
- Repeat with `ar.env` for RTL. Compare the PNGs with the previous run manually or with any image diff tool. Status: authored, not executed (Maestro is not installed in this environment).
