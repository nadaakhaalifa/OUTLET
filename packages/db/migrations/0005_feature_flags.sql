-- migration: 0005_feature_flags
-- phase: expand (additive only)
-- Source: docs/data-model.md section 7.3 (feature flags and kill switches).
--
-- Deviation from the data model (noted for review): the model sketches feature_flags (definition) plus
-- flag_rules (per market). Phase 0 ships ONE table keyed by (key, market_id) where market_id NULL is
-- the global row and a non-NULL row is a per-market override. `rules` jsonb carries targeting
-- (rolloutPercent, storeIds); it never holds user ids. Splitting into definition + rules can happen
-- later with an expand/contract migration.
-- Global configuration: no tenant column and no RLS. Every change is also written to audit_log by the
-- application (AuditPort); updated_by is the actor id.

CREATE TABLE feature_flags (
  key         text NOT NULL CHECK (length(key) > 0),
  market_id   text CHECK (market_id IS NULL OR length(market_id) > 0),
  enabled     boolean NOT NULL,
  rules       jsonb NOT NULL DEFAULT '{}'::jsonb,
  version     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by  text NOT NULL,
  updated_at  timestamptz NOT NULL
);
CREATE UNIQUE INDEX feature_flags_key_market_uq ON feature_flags (key, COALESCE(market_id, ''));
