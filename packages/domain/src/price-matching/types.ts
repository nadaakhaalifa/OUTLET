/** Price integrity v2: crawler and product matching (spec 08, master prompt 9.2). Pure: no IO, no clock, no randomness. */

export const MS_PER_SECOND = 1_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

/** Default match-confidence threshold in basis points (0.92, spec 9.2). Admin-audited config, dual approval. */
export const DEFAULT_TAU_BP = 9_200;
/** Precision the threshold must reach on the validation split (spec 08: 0.98). */
export const TARGET_PRECISION_BP = 9_800;
/** Minimum labelled pairs before external evidence may leave shadow mode (spec 9.2 VERIFY: 2,000). */
export const MIN_LABELLED_PAIRS = 2_000;
/** Minimum inter-annotator kappa, in thousandths (0.8). */
export const MIN_KAPPA_MILLI = 800;

/** Evidence older than this fails closed to a plain price (mirrors priceIntegrity.EXTERNAL_STALE_MS). */
export const EVIDENCE_STALE_MS = 72 * MS_PER_HOUR;
/** Polite crawling: at most one request per domain every 5 s (12 per minute). */
export const MIN_REQUEST_GAP_MS = 5_000;
export const MAX_REDIRECTS = 3;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const ROBOTS_CACHE_MS = 24 * MS_PER_HOUR;
export const SNAPSHOT_WINDOW_DAYS = 30;
/** Document evidence alone never supports more than this discount (spec 9.2.5). */
export const DOCUMENT_ONLY_MAX_DISCOUNT_PCT = 30;
