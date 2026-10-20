# Brand platform build plan (wave 1 started 2026-10-18)

Sources: docs/specs/store-branding-and-preview.md (ADR-0057), docs/specs/seller-teams-availability-alerts.md (ADR-0058),
docs/specs/product-photo-studio.md (ADR-0059), the dashboard and store-identity research (verified evidence is thin; see notes),
and the owner's Shopify overview screenshot as the home-screen bar. Zalando study pending; it may reorder later waves.

All specs are Proposed. Wave 1 uses each spec's safe defaults and builds only what carries no owner decision. Every feature
stays behind its kill switch (default blocked, ADR-0029). Nothing here changes prices, tiers, legal text or data hosting.

## Wave 1 (building now, disjoint scopes)
| # | Work | Spec | Tier | Scope |
|---|---|---|---|---|
| W1-A | Seller dashboard data: summary endpoint with previous-period comparison per KPI, daily sales series, top products, conversion funnel where events exist, COD refusal by governorate where data exists, data-freshness stamp; no invented numbers | research + seller-analytics | Builder | apps/api seller-analytics, openapi |
| W1-B | Photo studio S1: upload hardening, ICC to sRGB conversion fix in bg-removal, colour-accuracy check primitives | ADR-0059 S1 | Builder | apps/ml-services/bg-removal |
| W1-C | Store theme model: typed Zod theme document, font allow-list, WCAG 2.2 AA contrast guard with nearest-passing suggestion, locked-element contract; pure domain, no UI yet | ADR-0057 WP-S0..S2 | Builder | packages/domain, packages/validation |
| W1-D | Permission keys and eight preset roles, equivalence property test with today's behaviour, policy `brand_permission` grant kind | ADR-0058 T-WP0..1 | Builder then chief-reviewer | packages/policy |

## Wave 1 review results (2026-10-18)
- W1-D policy: chief-reviewer APPROVE WITH CHANGES for the pure layer; NO-GO for wiring into apps/api until fixed
  (transfer-then-approve bypass, owner recount transaction, subset bound, owner-target edits, ~20 modules still decide
  from the legacy brand role and fail closed for brand_permission actors; promotions authorizer has a private manager rule).
  Fix builder running; API wiring is a separate wave-2 package with its own chief-reviewer pass.
- W1-B photo studio S1: built (ICC to sRGB, upload hardening, CIEDE2000/SSIM primitives, edit label). ruff E501 failures
  in untouched files to triage.
- W1-C theme model: built. Domain test chart-of-accounts refundIssued property failed once in a full run; hunt running.
- Zalando size findings: about one third of returns are size-related, size advice cut those about 10%, portfolio prevented
  8% in 2025 (self-reported). Our section 10 gaps: item flags, size profile, size charts first.

## Wave 2 (after wave 1 review)
Mobile dashboard rewrite (Shopify-style KPI cards, previous-period deltas, funnel, top products, needs-action queue),
quick pause/price/stock edit and availability states, theme application in the store page, preview-as-customer and the
"What needs fixing" checklist, staff invites and permission UI, seller alerts and mute, photo template studio.

## Wave 3
Cart and back-in-stock reminders (consent-gated, default once per bag; DPO review before enabling), ghost mannequin,
Seller Center parity, Zalando-derived patterns once the study is reviewed.

## Gates for every item
Spec acceptance tests, negative authorization tests, AR/EN parity, design lint, depcruise, check-debt, coverage ratchet
(no baseline lowered), chief-reviewer on authorization and money display, no fake data shown to users (CPL 181/2018).

## Owner decisions still open (defaults in the specs apply meanwhile)
ADR-0057 O1-O10, ADR-0058 T-D1..T-D12, ADR-0059 O-1..O-8, semgrep python findings, dependency-audit allowlist, checkov skips,
merge target for PR 3.
