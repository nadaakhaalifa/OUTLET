-- migration: 0095_reserved_unused
-- phase: expand
--
-- Intentional no-op. The number 0095 was reserved for a dashboard-foundations track that did not need a
-- schema change. Filling the gap (rather than renumbering the later migrations) keeps every reference to
-- the neighbouring numbers in docs, ADRs, tests and tooling valid, and keeps the sequence contiguous.
-- No migration has been applied outside dev and test, so this is safe.
SELECT 1;
