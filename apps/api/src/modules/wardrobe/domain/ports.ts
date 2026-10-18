/** Ports of the wardrobe module (spec 28 feature 4, ADR-0043). No infrastructure imports. */
import type { PartialAttributes } from "./attributes";

export interface Clock {
  nowMs(): number;
}
export interface IdPort {
  uuidV7(): string;
}

export type ImageMime = "image/jpeg" | "image/png" | "image/webp";
export type ScanState = "pending_scan" | "clean" | "infected";
export type ImageState = "none" | ScanState;
export type AttributesSource = "user" | "vision";

export interface WardrobeItem {
  readonly id: string;
  readonly userId: string;
  /** Object-store key (scheme `wardrobe/yyyy/mm/uuid`, no user data). null for an item added by hand. */
  readonly imageRef: string | null;
  readonly imageState: ImageState;
  readonly attributes: PartialAttributes;
  readonly attributesSource: AttributesSource;
  readonly visionModelVersion: string | null;
  readonly version: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface UploadRecord {
  readonly id: string;
  readonly userId: string;
  readonly uploadId: string;
  readonly contentType: ImageMime;
  readonly sizeBytes: number;
  readonly issuedAtMs: number;
  readonly consumedAtMs: number | null;
}

export type WardrobeEvent =
  | { readonly type: "wardrobe.item_added"; readonly userId: string; readonly itemId: string; readonly hasPhoto: boolean }
  | { readonly type: "wardrobe.item_updated"; readonly userId: string; readonly itemId: string; readonly source: AttributesSource }
  | { readonly type: "wardrobe.item_deleted"; readonly userId: string; readonly itemId: string }
  | { readonly type: "wardrobe.cleared"; readonly userId: string; readonly count: number };

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export type CreateItemResult = "created" | "limit_reached" | "upload_unavailable";
export type UpdateItemResult = { readonly kind: "updated"; readonly item: WardrobeItem } | { readonly kind: "not_found" } | { readonly kind: "conflict" };

export interface WardrobeStore {
  /** Records an issued upload. "quota" when the shopper already has `max` unconsumed uploads. */
  insertUpload(u: UploadRecord, max: number): Promise<"stored" | "quota">;
  getUpload(userId: string, uploadId: string): Promise<UploadRecord | null>;
  /**
   * Inserts the item (and marks `uploadId` consumed in the same transaction). "limit_reached" when the
   * shopper already has `maxItems`; "upload_unavailable" when the upload is not theirs or already used.
   */
  insertItem(item: WardrobeItem, uploadId: string | null, maxItems: number, events: readonly WardrobeEvent[]): Promise<CreateItemResult>;
  getItem(id: string): Promise<WardrobeItem | null>;
  list(userId: string, limit: number, cursor: string | null): Promise<Page<WardrobeItem>>;
  /** Every item of the shopper, newest first (bounded by the item cap). */
  all(userId: string): Promise<readonly WardrobeItem[]>;
  /** Compare-and-set on `version`. */
  updateAttributes(
    id: string,
    userId: string,
    expectedVersion: number | null,
    attributes: PartialAttributes,
    source: AttributesSource,
    modelVersion: string | null,
    atMs: number,
    events: readonly WardrobeEvent[],
  ): Promise<UpdateItemResult>;
  setImageState(id: string, state: ScanState, atMs: number): Promise<void>;
  /** Deletes one item. Returns its photo key (to delete immediately) or null when it had none or did not exist. */
  deleteItem(id: string, userId: string, events: readonly WardrobeEvent[]): Promise<{ readonly deleted: boolean; readonly imageRef: string | null }>;
  /** Deletes every item and upload of the shopper (emits `wardrobe.cleared`). Returns the photo keys that existed. */
  clear(userId: string): Promise<{ readonly count: number; readonly imageRefs: readonly string[] }>;
}

// ---- object store (private bucket, existing signed-upload and scan path) ------------------------

export interface IssuedUpload {
  readonly uploadId: string;
  readonly url: string;
  /** Headers the client must send verbatim (they are signed). */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAtMs: number;
}

/** Facade over the object store. Production stays Unconfigured (503) until a bucket exists. */
export interface WardrobeImageStorePort {
  readonly configured: boolean;
  issue(input: { readonly ownerId: string; readonly contentType: ImageMime; readonly sizeBytes: number }): Promise<IssuedUpload>;
  /** True when the key has the wardrobe scheme, exists and is owned by `ownerId`. */
  owns(ownerId: string, uploadId: string): Promise<boolean>;
  scanState(uploadId: string): Promise<ScanState | null>;
  read(uploadId: string): Promise<Uint8Array | null>;
  /** Short-lived signed GET, only for a `clean` object. null otherwise. */
  signGet(uploadId: string, ttlSeconds: number): Promise<{ readonly url: string; readonly expiresAtMs: number } | null>;
  delete(uploadId: string): Promise<void>;
}

// ---- vision --------------------------------------------------------------------------------------

export interface AttributeSuggestion {
  readonly attributes: PartialAttributes;
  readonly modelVersion: string;
}

/**
 * Photo to attribute suggestions. Never a decision: the shopper confirms or edits. `in_region` is the
 * ADR-0002 default; `external` needs the `cross_border_ml` consent and a licence (VR-P3-13).
 */
export interface VisionAttributePort {
  readonly configured: boolean;
  readonly residency: "in_region" | "external";
  suggest(input: { readonly image: Uint8Array; readonly contentType: ImageMime }): Promise<AttributeSuggestion | null>;
}

export interface WardrobeConsentPort {
  /** Purpose `personalization` granted and the personalization toggle on. */
  personalizationGranted(userId: string): Promise<boolean>;
  crossBorderMlGranted(userId: string): Promise<boolean>;
}

export interface WardrobeFlagPort {
  isEnabled(key: string): Promise<boolean>;
}
