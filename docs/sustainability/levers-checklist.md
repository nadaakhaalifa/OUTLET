# Green software levers checklist (spec T10)

Status as of 2026-10-11. "Designed" means specified in docs; "built" means code exists; "verified" means measured. No lever is verified. Mark items VERIFY where evidence was not checked in the repo.

| # | Lever (mandatory per T10) | Status | Evidence / next step | Owner |
|---|---|---|---|---|
| 1 | AVIF/WebP with on-the-fly resize to device DPR | Designed (spec T3, section 25) | Image pipeline not confirmed built; VERIFY. Budget: PDP above-the-fold image payload < 400 KB | Mobile + platform |
| 2 | Lazy-load images and lists (FlashList, expo-image) | Designed | VERIFY in `apps/mobile` | Mobile |
| 3 | Video autoplay only on Wi-Fi or by user setting | Designed | VERIFY implemented | Mobile |
| 4 | Weekly image-payload budget check in CI | Not implemented | Add to CI; define threshold from section 25 | Platform |
| 5 | JS bundle < 6 MB budget check | Designed (section 25) | VERIFY CI check exists (`docs/engineering/architecture-fitness.md`) | Mobile |
| 6 | Scale non-prod to zero at night | Not implemented | Needs infra (ADR-0016 layout only); VERIFY | Platform |
| 7 | Batch jobs (reconciliation, analytics, training) in low-carbon windows where SLAs allow | Not implemented | Needs a grid-intensity signal (see sci-method.md VERIFY) and a scheduler | Platform + data |
| 8 | Right-size via autoscaling | Not implemented | Needs production workload and load-test data (`tooling/load`) | SRE |
| 9 | Crawler dedupe (ETag/If-Modified-Since, DOM hash) | Designed (spec 9.2, ADR-0027) | VERIFY adapter implements conditional requests | Price integrity |
| 10 | LLM caching and smallest adequate model | Designed (spec T12; `apps/api/src/modules/llm-gateway`) | VERIFY cache keys and per-feature budgets in code; `kill.stylist_llm` exists | ML platform |
| 11 | Hub consolidation (fewer parcels) | Specified (Phase 2 spec 09) | Not built; blocked on VR-11 | Logistics |
| 12 | Returns-resale lane | Specified (Phase 2 spec 09) | Not built | Product |
| 13 | Exchange-first returns reduce reverse logistics | Specified (spec 22) | Returns module exists; effect unmeasured | Product |
| 14 | Size recommendation to cut size returns (target -10%) | Specified (spec 10) | Effect unmeasured | ML |
| 15 | FinOps dashboards: cost per order, per 1k sessions | Not implemented | Needs billing data | SRE |
| 16 | Budget alerts per environment and per LLM feature | Not implemented | llm-gateway budgets exist in design; alert wiring VERIFY | SRE |
| 17 | Shopper-facing claims gated by methodology page | Rule defined | No carbon claims shipped; keep copy-lint rule (`tooling/copy-lint`) VERIFY covers it | Product + legal |

## Review cadence
Review quarterly and before each phase exit. A lever moves to "verified" only with a dated measurement recorded in measurement-status.md.
