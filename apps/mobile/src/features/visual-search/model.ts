/**
 * Visual search (phase 3 spec P3-08). Pure model, ports and in-memory fakes; no UI imports.
 * The query photo is personal data (P2): it is uploaded over the signed flow, used for one search and deleted
 * by the server. Nothing here stores the image or its bytes. A discount appears only when the server says the
 * item has a verified one (`verifiedPct`), and a low-confidence result set never claims an exact match.
 */
import { inferKind, type HomeProduct } from "../home/model";
import { PortError } from "../worlds/model";

export { PortError };

export type ImageSource = "camera" | "library";
export type ImageType = "image/jpeg" | "image/png" | "image/webp";

/** Server limits (spec P3-08): 10 MB and 4096 px. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_PX = 4096;
export const MAX_RESULTS = 24;

export interface PickedImage {
  /** Local file uri on the device. Never logged, never sent anywhere except the signed upload target. */
  readonly uri: string;
  readonly contentType: ImageType | null;
  /** Null when the picker did not report it; the uploader measures it before requesting the signed upload. */
  readonly sizeBytes: number | null;
  readonly width: number | null;
  readonly height: number | null;
}

export type PickOutcome =
  | { readonly kind: "picked"; readonly image: PickedImage }
  | { readonly kind: "cancelled" }
  | { readonly kind: "denied" };

export interface ImageSourcePort {
  pick(source: ImageSource): Promise<PickOutcome>;
}

export type ImageProblem = "unsupportedType" | "tooLarge" | "empty";

export function imageTypeFromName(nameOrUri: string): ImageType | null {
  const clean = (nameOrUri.split("?")[0] ?? "").toLowerCase();
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "image/jpeg";
  if (clean.endsWith(".png")) return "image/png";
  if (clean.endsWith(".webp")) return "image/webp";
  return null;
}

export function normalizeImageType(mime: string | null | undefined, uri: string): ImageType | null {
  const m = (mime ?? "").toLowerCase();
  if (m === "image/jpeg" || m === "image/jpg") return "image/jpeg";
  if (m === "image/png") return "image/png";
  if (m === "image/webp") return "image/webp";
  return m === "" ? imageTypeFromName(uri) : null;
}

/** Client-side pre-check so an obviously invalid photo never leaves the device. The server re-validates everything. */
export function checkImage(img: PickedImage): ImageProblem | null {
  if (img.contentType === null) return "unsupportedType";
  if (img.sizeBytes !== null && img.sizeBytes <= 0) return "empty";
  if (img.sizeBytes !== null && img.sizeBytes > MAX_IMAGE_BYTES) return "tooLarge";
  if ((img.width !== null && img.width > MAX_IMAGE_PX) || (img.height !== null && img.height > MAX_IMAGE_PX)) return "tooLarge";
  return null;
}

export interface VisualItem {
  readonly productId: string;
  readonly storeId: string;
  readonly categoryId: string;
  /** Empty when the catalog could not be read for it; the tile then shows the category-neutral name. */
  readonly title: string;
  readonly storeName: string;
  readonly price: bigint;
  /** Integer percent, present only when the server holds a verified claim for it. */
  readonly verifiedPct: number | null;
  readonly match: "close" | "similar";
}

export interface VisualResults {
  readonly items: readonly VisualItem[];
  /** The server could not find a confident match: show "closest we have", never an exact claim. */
  readonly lowConfidence: boolean;
  /** Text-attribute fallback was used (embedder or index down). */
  readonly degraded: boolean;
  readonly categoryGuess: string | null;
}

export interface SearchOptions {
  readonly crop?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly limit?: number;
}

export interface VisualSearchPort {
  /** Upload the photo over the signed flow and search. The server deletes the image after the search. */
  search(image: PickedImage, options?: SearchOptions): Promise<VisualResults>;
  /** "Visually similar" rail on a product page; no upload involved. */
  similarTo(productId: string, limit?: number): Promise<VisualResults>;
}

export type VisualFailureReason =
  | "disabled"
  | "rejected"
  | "unsupportedType"
  | "tooLarge"
  | "rateLimited"
  | "busy"
  | "unavailable";

/** Expected, user-explainable failures of a visual search (distinct from plain offline/failed). */
export class VisualSearchError extends Error {
  readonly reason: VisualFailureReason;
  constructor(reason: VisualFailureReason) {
    super(`visual search ${reason}`);
    this.name = "VisualSearchError";
    this.reason = reason;
  }
}

/* ---- view model ---- */

export type SectionKey = "closest" | "similar" | "closestWeHave";

export interface VisualSection {
  readonly key: SectionKey;
  readonly items: readonly VisualItem[];
}

export type VisualBanner = "lowConfidence" | "degraded" | null;

export interface VisualView {
  readonly empty: boolean;
  readonly banner: VisualBanner;
  readonly sections: readonly VisualSection[];
  readonly offerGlobal: boolean;
}

/**
 * Sections follow the server's match grade. With low confidence there is one neutral section: no item may be
 * presented as a "close" match, and the banner says these are the closest items in the catalog.
 */
export function buildVisualView(r: VisualResults, localOnly = false): VisualView {
  const items = r.items.slice(0, MAX_RESULTS);
  if (items.length === 0) return { empty: true, banner: null, sections: [], offerGlobal: localOnly };
  if (r.lowConfidence) {
    return { empty: false, banner: "lowConfidence", sections: [{ key: "closestWeHave", items }], offerGlobal: false };
  }
  const close = items.filter((i) => i.match === "close");
  const similar = items.filter((i) => i.match !== "close");
  const sections: VisualSection[] = [];
  if (close.length > 0) sections.push({ key: "closest", items: close });
  if (similar.length > 0) sections.push({ key: "similar", items: similar });
  return { empty: false, banner: r.degraded ? "degraded" : null, sections, offerGlobal: false };
}

/**
 * Tile data. `referencePrice` stays null on purpose: the visual search wire carries a verified percentage but
 * not the verified reference price, so a strike-through is never fabricated from it.
 */
export function toTile(i: VisualItem): HomeProduct {
  return {
    id: i.productId, title: i.title, storeId: i.storeId, storeName: i.storeName, kind: inferKind(i.title !== "" ? i.title : i.categoryId),
    price: i.price, referencePrice: null, verifiedPct: i.verifiedPct, isLaunchPrice: false, createdAtMs: 0, endsAtMs: null, sponsored: false,
  };
}

export type VisualScreenState =
  | { readonly status: "idle" }
  | { readonly status: "denied" }
  | { readonly status: "invalid"; readonly problem: ImageProblem }
  | { readonly status: "searching" }
  | { readonly status: "error"; readonly offline: boolean; readonly reason: VisualFailureReason | null }
  | { readonly status: "results"; readonly view: VisualView };

export function visualFailureState(e: unknown): VisualScreenState {
  if (e instanceof VisualSearchError) return { status: "error", offline: false, reason: e.reason };
  return { status: "error", offline: e instanceof PortError && e.kind === "offline", reason: null };
}

/** Whether a retry makes sense for this failure (an unsafe or unsupported photo needs a different photo). */
export function canRetry(reason: VisualFailureReason | null): boolean {
  return reason !== "rejected" && reason !== "unsupportedType" && reason !== "tooLarge" && reason !== "disabled";
}

/** Picks, validates, searches. Pure orchestration so the screen stays thin and the flow is unit-tested. */
export async function runVisualSearch(
  source: ImageSourcePort,
  port: VisualSearchPort,
  from: ImageSource,
  localOnly = false,
  onSearching?: () => void,
): Promise<VisualScreenState> {
  let picked: PickOutcome;
  try {
    picked = await source.pick(from);
  } catch {
    return { status: "error", offline: false, reason: null };
  }
  if (picked.kind === "cancelled") return { status: "idle" };
  if (picked.kind === "denied") return { status: "denied" };
  const problem = checkImage(picked.image);
  if (problem !== null) return { status: "invalid", problem };
  onSearching?.();
  try {
    return { status: "results", view: buildVisualView(await port.search(picked.image), localOnly) };
  } catch (e) {
    return visualFailureState(e);
  }
}

/* ---- in-memory fakes (development and tests only; synthetic data) ---- */

export const FIXTURE_VISUAL_ITEMS: readonly VisualItem[] = [
  { productId: "vs-1", storeId: "st-1", categoryId: "dresses", title: "Linen midi dress", storeName: "Fixture Store", price: 129_900n, verifiedPct: 32, match: "close" },
  { productId: "vs-2", storeId: "st-2", categoryId: "dresses", title: "Cotton shirt dress", storeName: "Fixture Studio", price: 99_900n, verifiedPct: null, match: "close" },
  { productId: "vs-3", storeId: "st-1", categoryId: "tops", title: "Ribbed knit top", storeName: "Fixture Store", price: 59_900n, verifiedPct: null, match: "similar" },
  { productId: "vs-4", storeId: "st-3", categoryId: "dresses", title: "Pleated wrap dress", storeName: "Fixture House", price: 149_900n, verifiedPct: 18, match: "similar" },
];

export class InMemoryVisualSearchPort implements VisualSearchPort {
  readonly searched: PickedImage[] = [];
  constructor(
    private results: VisualResults = { items: FIXTURE_VISUAL_ITEMS, lowConfidence: false, degraded: false, categoryGuess: "dresses" },
    private failure: VisualSearchError | PortError | null = null,
  ) {}
  setResults(r: VisualResults): void {
    this.results = r;
  }
  setFailure(f: VisualSearchError | PortError | null): void {
    this.failure = f;
  }
  async search(image: PickedImage): Promise<VisualResults> {
    if (this.failure !== null) throw this.failure;
    this.searched.push(image);
    return this.results;
  }
  async similarTo(productId: string, limit = 12): Promise<VisualResults> {
    if (this.failure !== null) throw this.failure;
    return { ...this.results, items: this.results.items.filter((i) => i.productId !== productId).slice(0, limit), lowConfidence: false };
  }
}

export class FakeImageSource implements ImageSourcePort {
  readonly calls: ImageSource[] = [];
  constructor(private outcome: PickOutcome = { kind: "picked", image: { uri: "file:///fixture.jpg", contentType: "image/jpeg", sizeBytes: 200_000, width: 1200, height: 1600 } }) {}
  setOutcome(o: PickOutcome): void {
    this.outcome = o;
  }
  async pick(source: ImageSource): Promise<PickOutcome> {
    this.calls.push(source);
    return this.outcome;
  }
}
