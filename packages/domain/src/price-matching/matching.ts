import { DEFAULT_TAU_BP } from "./types";
import { HAMMING_NEAR_DUPLICATE_MAX, cosine, hamming64, normalizeGtin } from "./hashing";

/**
 * Product matching waterfall (spec 9.2.3):
 *   1 GTIN/EAN exact (or same-seller SKU)  ->  2 pHash/dHash near-duplicate  ->  3 embedding ANN
 *   ->  4 attribute check (LLM, seller text untrusted)  ->  5 calibrated confidence.
 * Everything here is deterministic and unit-free: confidences are integer basis points.
 */

export interface ProductFingerprint {
  readonly gtin?: string | null;
  readonly sellerSku?: string | null;
  readonly pHash?: string | null;
  readonly dHash?: string | null;
  readonly embedding?: readonly number[] | null;
}

export type AttrAgreement = "match" | "conflict" | "unknown";

/** Output of the attribute check (stage 4). Schema-validated upstream (LLM05). */
export interface AttributeVerdict {
  readonly brand: AttrAgreement;
  readonly colour: AttrAgreement;
  readonly material: AttrAgreement;
  readonly sizeRun: "overlap" | "disjoint" | "unknown";
}

export type MatchMethod = "gtin" | "seller_sku" | "image_hash" | "embedding" | "image_and_embedding" | "none";

export type CapReason =
  | "gtin_conflict"
  | "no_signal"
  | "attributes_unavailable"
  | "attribute_conflict"
  | "size_run_disjoint"
  | "colour_unconfirmed";

export interface MatchScore {
  readonly method: MatchMethod;
  /** Uncalibrated score, 0..10000. */
  readonly rawBp: number;
  /** Final calibrated and capped confidence, 0..10000. */
  readonly confBp: number;
  readonly cap: CapReason | null;
  readonly signals: {
    readonly imageSimBp: number | null;
    readonly hamming: number | null;
    readonly embeddingSimBp: number | null;
  };
}

export interface ScoreInput {
  readonly haul: ProductFingerprint;
  readonly external: ProductFingerprint;
  /** Same seller owns both listings (their own site): enables the seller-SKU rung. */
  readonly sameSeller: boolean;
  /** null = the attribute check was not run or the gateway was unavailable (fails closed). */
  readonly attributes: AttributeVerdict | null;
  /** Calibration map from raw to calibrated basis points; identity when none is fitted. */
  readonly calibrate?: (rawBp: number) => number;
}

const GTIN_RAW = 9_900;
const SKU_RAW = 9_400;
/** Single-signal evidence is discounted: one image or one embedding alone cannot reach tau. */
const SINGLE_SIGNAL_WEIGHT_BP = 8_500;
const CAP_UNVERIFIED = 5_000;
const CAP_CONFLICT = 3_000;
const CAP_SIZE_RUN = 4_000;
const CAP_COLOUR_UNKNOWN = 8_000;

const clampBp = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(10_000, Math.round(n))) : 0);

/** 0 bits apart = 10000, each differing bit costs 500 bp, so the 6-bit limit scores 7000. Beyond it: no signal. */
function imageSimBp(distance: number): number {
  return distance > HAMMING_NEAR_DUPLICATE_MAX ? 0 : 10_000 - distance * 500;
}

/** cos 0.5 -> 0, cos 1.0 -> 10000 (linear). */
function embeddingSimBp(cos: number): number {
  return clampBp(((cos - 0.5) / 0.5) * 10_000);
}

export function scoreMatch(input: ScoreInput): MatchScore {
  const { haul, external } = input;
  const calibrate = input.calibrate ?? ((n: number): number => n);
  const none = (cap: CapReason): MatchScore => ({
    method: "none",
    rawBp: 0,
    confBp: 0,
    cap,
    signals: { imageSimBp: null, hamming: null, embeddingSimBp: null },
  });

  // Stage 1: identifiers.
  const gA = typeof haul.gtin === "string" ? normalizeGtin(haul.gtin) : null;
  const gB = typeof external.gtin === "string" ? normalizeGtin(external.gtin) : null;
  if (gA !== null && gB !== null) {
    if (gA !== gB) return none("gtin_conflict");
    const conf = clampBp(calibrate(GTIN_RAW));
    return { method: "gtin", rawBp: GTIN_RAW, confBp: conf, cap: null, signals: { imageSimBp: null, hamming: null, embeddingSimBp: null } };
  }
  const sA = haul.sellerSku?.trim().toLowerCase() ?? "";
  const sB = external.sellerSku?.trim().toLowerCase() ?? "";
  if (input.sameSeller && sA.length >= 3 && sA === sB) {
    const conf = clampBp(calibrate(SKU_RAW));
    return { method: "seller_sku", rawBp: SKU_RAW, confBp: conf, cap: null, signals: { imageSimBp: null, hamming: null, embeddingSimBp: null } };
  }

  // Stages 2 and 3: image hash and embedding.
  let hamming: number | null = null;
  for (const [a, b] of [
    [haul.pHash, external.pHash],
    [haul.dHash, external.dHash],
  ] as const) {
    if (typeof a !== "string" || typeof b !== "string") continue;
    const d = hamming64(a, b);
    if (d !== null && (hamming === null || d < hamming)) hamming = d;
  }
  const img = hamming === null ? null : imageSimBp(hamming);
  const cos = haul.embedding && external.embedding ? cosine(haul.embedding, external.embedding) : null;
  const emb = cos === null ? null : embeddingSimBp(cos);
  const signals = { imageSimBp: img, hamming, embeddingSimBp: emb };
  if (img === null && emb === null) return { ...none("no_signal"), signals };

  let method: MatchMethod;
  let raw: number;
  if (img !== null && emb !== null) {
    method = "image_and_embedding";
    raw = (img + emb) / 2;
  } else if (img !== null) {
    method = "image_hash";
    raw = (img * SINGLE_SIGNAL_WEIGHT_BP) / 10_000;
  } else {
    method = "embedding";
    raw = ((emb ?? 0) * SINGLE_SIGNAL_WEIGHT_BP) / 10_000;
  }
  raw = clampBp(raw);
  if (raw === 0) return { ...none("no_signal"), method: "none", signals };

  // Stage 4: attribute check caps the calibrated confidence.
  let cap: CapReason | null = null;
  let ceiling = 10_000;
  const a = input.attributes;
  if (a === null) {
    cap = "attributes_unavailable";
    ceiling = CAP_UNVERIFIED;
  } else if (a.brand === "conflict" || a.colour === "conflict" || a.material === "conflict") {
    cap = "attribute_conflict";
    ceiling = CAP_CONFLICT;
  } else if (a.sizeRun === "disjoint") {
    cap = "size_run_disjoint";
    ceiling = CAP_SIZE_RUN;
  } else if (a.colour === "unknown") {
    cap = "colour_unconfirmed";
    ceiling = CAP_COLOUR_UNKNOWN;
  }
  // Stage 5: calibration, then the cap.
  const conf = Math.min(clampBp(calibrate(raw)), ceiling);
  return { method, rawBp: raw, confBp: conf, cap, signals };
}

/** Only `confBp >= tau` counts as a match (spec 9.2). */
export function isMatch(score: MatchScore, tauBp: number = DEFAULT_TAU_BP): boolean {
  return score.confBp >= tauBp;
}
