-- migration: 0058_phase3_reserved_unused_a
-- phase: expand
--
-- Intentional no-op. The number 0058 was reserved for a Phase 3 change that did not need a schema
-- change. Filling the gap (rather than renumbering the later migrations) keeps every reference to
-- 0059..0082 in docs, ADRs, tests and tooling valid, and keeps the sequence contiguous.
-- No migration has been applied outside dev and test, so this is safe.
SELECT 1;
