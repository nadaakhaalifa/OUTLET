# Release checklist (consolidates spec P1)

Status: Done / Partial / Open / Blocked (owner decision). Date 2026-10-11.

| Area | Item | Status | Owner |
|---|---|---|---|
| App Store | Privacy manifest + labels | Partial (config + draft docs) | Eng/DPO |
| App Store | Account deletion, Sign in with Apple, demo account | Open (verify in app) | Eng |
| App Store | Plus plan decided (A/B), early App Review consultation | Blocked (VERIFY row 10) | Owner |
| App Store | Bundle id/package/slug final | Blocked (open question 9) | Owner |
| App Store | Apple + Google accounts, EAS init, credentials | Open | Owner (docs/engineering/eas.md) |
| Legal | ToS, Seller Agreement, Privacy Policy, consent texts, Subscription/Gift Card/Store Credit/Rewards/Referral terms, Returns policy, accessibility statement (AR authoritative + EN) | Partial (drafts, see legal-pack-status.md) | Counsel |
| Regulatory | PDPC licence, DPO appointed (by 1 Nov 2026), transfer licence if needed | Open | Legal/DPO |
| Regulatory | CBE opinion on store credit, FRA/BNPL rules | Open | Legal/Finance |
| Regulatory | ETA registration, e-invoice/e-receipt live, VAT registration | Open | Tax |
| Security | External pen test, ASVS L2 matrix, MASVS tests, SAQ A + FAQ 1588 evidence, SBOM/signing | Open | Security |
| Reliability | 20x load test, drop simulation, restore drill, on-call staffed | Open | SRE |
| Contracts | PSPs (primary + failover, Fawry), 1+ BNPL, Bosta + Aramex, SMS + WhatsApp BSP | Open | Finance/Ops |
| Supply | 30 curated brands with channel integrations connected 30+ days before launch | Open | Ops |
| Support | AR/EN staffed incl. WhatsApp, macros | Open | Ops |
| Go-to-market | 72-hour Mega Drop, waitlist leaderboard, 50 micro-creators | Open | Marketing |
| Release eng | eas.json profiles, channels, fingerprint runtime, staged OTA + rollback criteria | Done (documented; rollback automation not built) | Eng |
| Release eng | Full VERIFY register closed or accepted | Open | Owners |

## Migration numbers reserved before first commit
`packages/db/migrations/RESERVED` lists 0091 and 0095 as reserved gaps, and the file states it must be empty on merge. Before the first commit the owner must either create real migrations for those numbers or accept removing the RESERVED entries together with a runner and test change (made in `packages/db`, not in docs).

## Guest-browsing launch gates (ADR-0055)
- 180-day recycled-number step-up (VR-GUEST-06): implement in both OTP modes (new device on a number unused for more than 180 days needs a second factor before any stored value is shown). Blocker before real users, not before staging.
- `DevRouteBridge` must be absent in release builds (`__DEV__` false): verify in the release bundle before submission.
