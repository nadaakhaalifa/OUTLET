import type {
  BrandHistory,
  ChartError,
  ChartRow,
  FitPreference,
  FitRating,
  ItemCounts,
  LengthUnit,
  Stretch,
} from "./bridge";

export type ProfileKind = "me" | "partner" | "child";

/** What the repository stores. Ciphertext only for every P3 field (spec section 10, B1). */
export interface ProfileRecord {
  readonly id: string;
  readonly userId: string;
  readonly kind: ProfileKind;
  readonly labelEnc: Uint8Array;
  readonly measurementsEnc: Uint8Array | null;
  readonly quickStartEnc: Uint8Array | null;
  readonly fitPreference: FitPreference;
  readonly modestFit: boolean;
  /** Optimistic concurrency counter, bumped on every write. */
  readonly version: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/** Owner scoped: every method takes the user id, a profile of another user is simply absent. */
export interface SizeProfileRepository {
  countLive(userId: string): Promise<number>;
  insert(record: ProfileRecord): Promise<void>;
  get(userId: string, id: string): Promise<ProfileRecord | null>;
  list(userId: string, page: { cursor: string | null; limit: number }): Promise<Page<ProfileRecord> | "invalid_cursor">;
  /** Replaces the row when `expectedVersion` still matches. */
  update(record: ProfileRecord, expectedVersion: number): Promise<"updated" | "conflict" | "not_found">;
  delete(userId: string, id: string): Promise<boolean>;
}

export interface StoredChart {
  readonly id: string;
  readonly storeId: string;
  readonly productType: string;
  readonly chartVersion: number;
  readonly unitEntered: LengthUnit;
  /** Normalised to cm, in submitted order. */
  readonly rows: readonly ChartRow[];
  readonly validated: boolean;
  readonly validationErrors: readonly ChartError[];
  readonly createdAtMs: number;
}

export interface SizeChartRepository {
  nextVersion(storeId: string, productType: string): Promise<number>;
  insert(chart: StoredChart): Promise<void>;
  /** Tenant scoped list. */
  listForStore(storeId: string, page: { cursor: string | null; limit: number }): Promise<Page<StoredChart> | "invalid_cursor">;
  /** Highest validated version for a store and product type, or null. */
  latestValidated(storeId: string, productType: string): Promise<StoredChart | null>;
}

export interface FeedbackRecord {
  readonly id: string;
  readonly orderLineId: string;
  readonly userId: string;
  /** Null once the profile was deleted. */
  readonly profileId: string | null;
  readonly productId: string;
  readonly brandId: string;
  readonly productType: string;
  readonly sizeChartId: string | null;
  readonly sizeLabel: string;
  readonly rating: FitRating;
  readonly area: string | null;
  readonly submittedAtMs: number;
}

export interface FeedbackRepository {
  /** Unique on order line. */
  insert(record: FeedbackRecord): Promise<"created" | "duplicate">;
  /** The user's own feedback in one brand. */
  historyFor(userId: string, brandId: string): Promise<BrandHistory>;
  /** Counters across all users for one product and chart. Aggregate only. */
  itemCounts(productId: string, sizeChartId: string): Promise<ItemCounts>;
  /** Called when a profile is deleted: keeps the aggregate, drops the link. */
  detachProfile(userId: string, profileId: string): Promise<void>;
}

export interface DemandRepository {
  /** Idempotent per (cell, shopperId): repeat requests by one shopper never raise the count. */
  record(storeId: string, productType: string, sizeLabel: string, week: string, shopperId: string): Promise<void>;
  /** demandCount = DISTINCT shoppers. Raw counters for a store. The use case applies k-anonymity before returning anything. */
  cellsForStore(storeId: string): Promise<readonly { productType: string; sizeLabel: string; week: string; demandCount: number }[]>;
}

/** Envelope encryption of one field. `aad` binds the ciphertext to its row and purpose. */
export interface FieldCipherPort {
  encrypt(plaintext: Uint8Array, aad: string): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array, aad: string): Promise<Uint8Array>;
}

export interface MeasurementsConsentPort {
  isGranted(userId: string): Promise<boolean>;
}

export interface ProductFitFacts {
  readonly productId: string;
  readonly storeId: string;
  readonly brandId: string;
  readonly productType: string;
  readonly stretch: Stretch;
}

/** Read side of the catalog. `null` = unknown or unlisted product. */
export interface FitCatalogPort {
  productFitFacts(productId: string): Promise<ProductFitFacts | null>;
}

export type DeliveredLine =
  | { readonly kind: "delivered"; readonly line: DeliveredLineFacts }
  | { readonly kind: "not_delivered" };

export interface DeliveredLineFacts {
  readonly orderLineId: string;
  readonly productId: string;
  readonly brandId: string;
  readonly productType: string;
  readonly sizeLabel: string;
  readonly sizeChartId: string | null;
}

/** Read side of orders. Returns null when the line does not exist or is not the user's. */
export interface OrderLineFitPort {
  lineFor(userId: string, orderLineId: string): Promise<DeliveredLine | null>;
}

export type SizingEvent =
  | { readonly type: "size_profile.updated"; readonly profileId: string; readonly userId: string }
  | { readonly type: "size_chart.validated"; readonly chartId: string; readonly storeId: string; readonly validated: boolean }
  | {
      readonly type: "fit_feedback.submitted";
      readonly orderLineId: string;
      readonly productId: string;
      readonly brandId: string;
      readonly rating: FitRating;
    }
  /** Analytics event from docs/analytics/event-taxonomy.md (needs the `measurements` consent). */
  | { readonly type: "size_recommended"; readonly productId: string; readonly confidence: number };

export interface SizingEventPublisher {
  publish(event: SizingEvent): Promise<void>;
}
