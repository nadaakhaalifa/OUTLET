-- migration: 0059_plans_kind_seat_limit
-- phase: expand
--
-- Family and student plans (docs/specs/phase-3/family-student-plans.md, section 14, ADR-0012).
-- Extends the versioned `plans` rows with a kind and a seat limit. Expand only:
--   * kind defaults to 'individual', so every Phase 2 row keeps its meaning and no backfill is needed.
--   * seat_limit is set exactly for family plans (1..8, owner included) and NULL otherwise.
--   * a new price or seat limit is a new plan version, never an edit (existing plan versioning).
-- Existing code patterns (plus_[a-z0-9_]+) already admit plus_family and plus_student.

ALTER TABLE plans
  ADD COLUMN kind text NOT NULL DEFAULT 'individual'
    CONSTRAINT plans_kind_chk CHECK (kind IN ('individual', 'family', 'student'));

ALTER TABLE plans
  ADD COLUMN seat_limit smallint
    CONSTRAINT plans_seat_limit_range_chk CHECK (seat_limit IS NULL OR seat_limit BETWEEN 1 AND 8);

ALTER TABLE plans
  ADD CONSTRAINT plans_seat_limit_kind_chk CHECK ((kind = 'family') = (seat_limit IS NOT NULL));
