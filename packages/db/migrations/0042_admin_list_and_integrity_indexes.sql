-- migration: 0042_admin_list_and_integrity_indexes
-- phase: expand (indexes only; no column, constraint or grant change)
--
-- 1. Admin ops lists (apps/api/src/modules/admin/ops-lists.ts) page with keyset `ORDER BY created_at DESC, id DESC` and
--    `(created_at, id) < ($at, $id)`, always pinned to market_id. Without a (market_id, created_at DESC, id DESC) shaped index a deep page
--    is a scan plus sort of the market's rows. Each index below matches one query shape exactly:
--      refunds         unfiltered   : market_id = $1                                  -> refunds_market_created_idx
--      refunds         ?status=X    : market_id = $1 AND status = X                   -> refunds_market_status_created_idx
--      payouts         unfiltered   : market_id = $1 AND status <> 'CANCELLED'        -> payouts_market_created_idx (partial, same predicate)
--      payouts         ?status=X    : the same plus status = X                        -> payouts_market_status_created_idx (partial)
--      return_requests every stage  : market_id = $1 AND status IN (REQUESTED, IN_TRANSIT, RECEIVED) [AND one status / overdue filter]
--                                                                                     -> return_requests_pipeline_created_idx (partial; a stage is a
--                                                                                        filter on the ordered scan of a small open set)
--      disputes        default open : market_id = $1 AND status IN (OPEN, UNDER_REVIEW) -> disputes_open_created_idx (partial)
--      disputes        ?status=X    : market_id = $1 AND status = X                   -> disputes_market_status_created_idx
--    Existing indexes (0018, 0019, 0035) are store-, user- or due_at-led and do not serve these orderings, so nothing here duplicates them.
--
-- 2. Ledger integrity trial balance (packages/payouts integrity-job: per-currency sum of postings per market) groups on (market_id, currency)
--    and sums amount_minor. postings_market_currency_amount_idx lets it run as an index-only scan instead of reading the whole heap.
--    Write-cost trade-off: postings is the highest-volume append-only table; this adds one more index entry (market_id, currency, amount_minor)
--    to every posting insert (about 20 bytes per row, one extra B-tree insert; the key is low-cardinality so inserts stay in a few hot pages)
--    and some WAL. Accepted because the integrity pass runs nightly and a full heap scan at 4M users is far worse. Index-only scans need a
--    current visibility map: autovacuum on postings must keep up (append-only, so it does).
--    Write cost of the list indexes: one entry per insert on refunds/payouts/return_requests/disputes (low-volume tables, status updates
--    that leave status inside a partial predicate or change status on an indexed column also touch the index; HOT updates are lost for status changes).
--
-- Production: this file uses plain CREATE INDEX because migrations run offline in dev and CI. In production create each index with
-- CREATE INDEX CONCURRENTLY (BUILD-PROMPT rules; no runbook exists yet in docs/runbooks, add one) outside a transaction, then ship this file as IF NOT EXISTS no-ops.
-- Indexes need no data_inventory tags (privacy:check covers new columns only).

CREATE INDEX IF NOT EXISTS refunds_market_created_idx ON refunds (market_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS refunds_market_status_created_idx ON refunds (market_id, status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS payouts_market_created_idx ON payouts (market_id, created_at DESC, id DESC) WHERE status <> 'CANCELLED';
CREATE INDEX IF NOT EXISTS payouts_market_status_created_idx ON payouts (market_id, status, created_at DESC, id DESC) WHERE status <> 'CANCELLED';

CREATE INDEX IF NOT EXISTS return_requests_pipeline_created_idx ON return_requests (market_id, created_at DESC, id DESC) WHERE status IN ('REQUESTED', 'IN_TRANSIT', 'RECEIVED');

CREATE INDEX IF NOT EXISTS disputes_open_created_idx ON disputes (market_id, created_at DESC, id DESC) WHERE status IN ('OPEN', 'UNDER_REVIEW');
CREATE INDEX IF NOT EXISTS disputes_market_status_created_idx ON disputes (market_id, status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS postings_market_currency_amount_idx ON postings (market_id, currency) INCLUDE (amount_minor);
