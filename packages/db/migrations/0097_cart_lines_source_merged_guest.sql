-- migration: 0097_cart_lines_source_merged_guest
-- phase: expand
--
-- Guest browsing (ADR-0055, spec docs/specs/guest-browsing.md section 3): lines that arrive from a device-only
-- guest bag through POST /v1/me/guest-merge carry source = 'merged_guest'.
--
--   * cart_lines.source CHECK is replaced by a strictly WIDER list (adds 'merged_guest'). Every existing row still
--     satisfies it, so nothing is rewritten; the old constraint is dropped and the new one added in the same migration.
-- Privacy: no new column, no personal data (a constant label on an existing P1 column). data_inventory.yaml unchanged.
-- Rollback: restore the previous list after updating any 'merged_guest' rows (UPDATE cart_lines SET source = NULL).

-- lint-allow: drop-constraint-or-index replaced in the same migration by a strictly wider CHECK (adds merged_guest)
ALTER TABLE cart_lines DROP CONSTRAINT IF EXISTS cart_lines_source_check;
ALTER TABLE cart_lines ADD CONSTRAINT cart_lines_source_check
  CHECK (source IS NULL OR source IN
    ('pdp', 'search', 'stylist', 'wishlist', 'feed', 'bag_suggestion', 'reorder', 'merged_guest'));
