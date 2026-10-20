# Data model: creators and affiliates

Spec: `docs/specs/phase-3/creators-affiliates.md`, ADR-0037. Migrations 0074 to 0077. PII classes follow `docs/privacy/data_inventory.yaml`.

| Table | Purpose | Key columns | Notes |
|---|---|---|---|
| `creator_terms` | Versioned AR/EN terms text | `(version, locale)`, `body_sha256` | Immutable by trigger |
| `creator_accounts` | One per user | `user_id` unique, `handle` unique, `status`, `kyc_state`, `payout_pref` | Not cascaded from users: money history is pseudonymised, never row-deleted |
| `creator_kyc` | Sealed KYC (P3) | `*_enc bytea`, `national_id_hash` unique | System role only; tax fields VERIFY (VR-P3-03) |
| `affiliate_links` | Links to product, store or look | `slug` unique, one ACTIVE per `(creator, target)` | No creator-entered price anywhere |
| `creator_looks`, `creator_look_items` | Curated looks | `status` DRAFT, PUBLISHED, TAKEN_DOWN, ARCHIVED; items are catalog ids | Max 12 items |
| `affiliate_clicks` | Click log, range partitioned monthly | `device_hash`, `ip_hash`, `ua_class`, `counted` | No user id; default partition plus 2026-10..12 |
| `attributions` | One per order group | `order_group_id` PK, `rate_snapshot`, `window_end`, `status`, `void_reason` | System role only (buyer id) |
| `commissions` | One per `(order_line_id, creator_id)` | `base`, `rate_bps`, `amount`, `clawed_back`, `state`, `hold_reason`, `payout_id` | `clawed_back <= amount` by CHECK |
| `commission_postings` | Ledger intents | `(commission_id, seq)`, `kind`, `amount`, `posted_at` | Written in the claim transaction |
| `creator_monthly_accruals` | Monthly cap counter | `(creator_id, month_key)` | Conditional upsert is the atomic cap |
| `creator_payouts` | Payout batches | `state` (seller payout machine), `attempt` | One open payout per creator (partial unique) |

Ledger: `creator_payable:{user_id}` (liability, credit, persisted owner `user`) and `creator_commission_expense` (expense, debit, platform). Commission state machine: ACCRUING to ACCRUED (or VOIDED), ACCRUED to PAID or CLAWED_BACK, PAID to CLAWED_BACK.
