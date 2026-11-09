import { z } from "zod";

/**
 * Tile payloads of the admin dashboard (docs/api/admin-dashboard-contract.md section 3). One definition, two users: the rollup validates what it
 * writes into admin_dashboard_snapshots, and the API validates what it reads back (DB JSON is a boundary) and re-uses the same shapes in its response.
 */
const Count = z.int().nonnegative();
const Iso = z.iso.datetime({ offset: true });
export const Money = z.object({ amount_minor: z.string().regex(/^-?\d{1,19}$/), currency: z.string().regex(/^[A-Z]{3}$/) }).strict();
export type Money = z.infer<typeof Money>;
const Oldest = { oldest_at: Iso.nullable() };

export const SNAPSHOT_TILE_DATA = {
  orders_by_step: z.object({ paid_awaiting_accept: Count, accepted: Count, packed: Count, in_transit: Count, delivery_failed: Count }).strict(),
  seller_sla_breaches: z.object({ late_accept: Count, late_dispatch: Count, ...Oldest }).strict(),
  cod_awaiting_confirmation: z.object({ count: Count, ...Oldest }).strict(),
  returns_pipeline: z.object({ requested: Count, in_transit: Count, awaiting_inspection: Count, inspection_overdue: Count }).strict(),
  disputes_open: z.object({ open: Count, past_sla: Count, ...Oldest }).strict(),
  refunds_waiting: z.object({ count: Count, amount: Money, manual_review: Count, failed: Count, ...Oldest }).strict(),
  refunds_overdue: z.object({ count: Count, amount: Money, oldest_due_at: Iso.nullable() }).strict(),
  payouts: z.object({ due_count: Count, due_net: Money, on_hold_count: Count, on_hold_net: Money, failed: Count, open_holds: Count }).strict(),
  recon_unmatched: z.object({ open: Count, escalated: Count, aged_over_3d: Count, ...Oldest }).strict(),
  stores_moderation: z.object({ pending_review: Count, suspended: Count }).strict(),
  price_enforcement: z.object({ active: Count, pending_review: Count, suspensions_awaiting_review: Count }).strict(),
  verified_discount_share: z.object({ verified: Count, live_skus: Count }).strict(),
  listings_by_status: z.object({ published: Count, in_review: Count, paused: Count, blocked: Count }).strict(),
  breaches_open: z.object({ open: Count, next_pdpc_deadline_at: Iso.nullable(), next_subjects_deadline_at: Iso.nullable() }).strict(),
  dsar_queue: z.object({ open: Count, due_7d: Count, overdue: Count }).strict(),
} as const;

export type SnapshotTileKey = keyof typeof SNAPSHOT_TILE_DATA;
export const SNAPSHOT_TILE_KEYS = Object.keys(SNAPSHOT_TILE_DATA) as readonly SnapshotTileKey[];
export type SnapshotTileData<K extends SnapshotTileKey> = z.infer<(typeof SNAPSHOT_TILE_DATA)[K]>;
export const isSnapshotTileKey = (k: string): k is SnapshotTileKey => Object.hasOwn(SNAPSHOT_TILE_DATA, k);

/** Payload version stored in admin_dashboard_snapshots.version; bump when a tile's shape changes (readers refuse a version they do not know). */
export const SNAPSHOT_VERSION = 1;

/** Trigger event of the rollup job (inbox consumer `reporting.rollup`). */
export const ROLLUP_REQUESTED_EVENT = "reporting.rollup_requested";
export const ROLLUP_CONSUMER = "reporting.rollup";
/** sales: recompute the last `days` market days (default 3); nightly: the last 90; snapshots: the queue-count tiles only. */
export const RollupRequest = z.object({ scope: z.enum(["sales", "nightly", "snapshots"]), days: z.int().min(1).max(120).optional() }).loose();
export type RollupRequest = z.infer<typeof RollupRequest>;
