import type { Grade, ListingStatus, Ownership, Proceeds, ProceedsTerms, ResaleReturnClass } from "./bridge";

export interface ListingRecord {
  readonly id: string;
  readonly returnId: string;
  /** One physical unit loops through resale at most once. */
  readonly unitRef: string;
  readonly storeId: string;
  readonly sourceSkuId: string;
  readonly resaleSkuId: string;
  readonly grade: Grade;
  readonly photoIds: readonly string[];
  readonly defectNote: string | null;
  /** Integer piastres, VAT-inclusive. Set by the grader, never derived from the original price. */
  readonly price: bigint;
  readonly ownership: Ownership;
  readonly status: ListingStatus;
  readonly listedAtMs: number;
  readonly soldAtMs: number | null;
  readonly createdBy: string;
}

export interface ProceedsRecord {
  readonly listingId: string;
  readonly gross: bigint;
  readonly sellerPayable: bigint;
  readonly platformRetained: bigint;
  readonly ledgerEntryId: string | null;
  readonly recordedAtMs: number;
}

export type ResaleEvent =
  | { readonly type: "resale.listed"; readonly listingId: string; readonly storeId: string; readonly grade: Grade }
  | { readonly type: "resale.sold"; readonly listingId: string; readonly storeId: string }
  | { readonly type: "resale.withdrawn"; readonly listingId: string; readonly storeId: string };

export interface ListingCursor {
  readonly listedAtMs: number;
  readonly id: string;
}

export interface ResaleStore {
  insertListing(l: ListingRecord, events: readonly ResaleEvent[]): Promise<"created" | "duplicate_return" | "duplicate_unit">;
  getListing(id: string): Promise<ListingRecord | null>;
  countForUnit(unitRef: string): Promise<number>;
  /** LISTED only, newest first. */
  listLive(limit: number, after: ListingCursor | null): Promise<readonly ListingRecord[]>;
  listForStore(storeId: string, limit: number): Promise<readonly ListingRecord[]>;
  /** Admin ops view: every listing (optionally one status), newest first, keyset on (listedAt, id). */
  listAll(limit: number, after: ListingCursor | null, status: ListingStatus | null): Promise<readonly ListingRecord[]>;
  getProceeds(listingId: string): Promise<ProceedsRecord | null>;
  /** One transaction: LISTED -> SOLD by compare-and-set, proceeds row, outbox. */
  markSold(i: { readonly listingId: string; readonly nowMs: number; readonly proceeds: ProceedsRecord; readonly events: readonly ResaleEvent[] }): Promise<"ok" | "not_listed" | "not_found">;
  withdraw(i: { readonly listingId: string; readonly events: readonly ResaleEvent[] }): Promise<"ok" | "not_listed" | "not_found">;
}

export interface ReturnFacts {
  readonly returnId: string;
  readonly unitRef: string;
  readonly sourceSkuId: string;
  readonly storeId: string;
  /** Hub that inspected the unit: only its operators may list it. */
  readonly hubId: string;
  readonly inspectionPassed: boolean;
  readonly returnClass: ResaleReturnClass;
  readonly ownership: Ownership;
}
export interface ReturnFactsPort {
  facts(returnId: string): Promise<ReturnFacts | null>;
}

export interface ResaleConsentPort {
  /** The seller opted in to open-box relisting of their returned units. Fails closed. */
  sellerOptedIn(storeId: string): Promise<boolean>;
  /** A signed return-to-vendor term covers a hub-owned unit. Fails closed. */
  rtvTermsAccepted(unitRef: string): Promise<boolean>;
}

export interface ResaleTermsPort {
  termsFor(storeId: string, ownership: Ownership): Promise<ProceedsTerms>;
}

export interface ResaleCatalogPort {
  /** Idempotent by `listingId`: the open-box SKU a shopper adds to the bag. */
  createResaleSku(i: { readonly listingId: string; readonly sourceSkuId: string; readonly storeId: string }): Promise<string>;
}

export interface ResaleFlagsPort {
  /** `kill.resale_lane`: true means listing may run. Fails closed. */
  listingEnabled(): Promise<boolean>;
}

export interface ResaleLedgerPort {
  post(entry: { readonly idempotencyKey: string; readonly lines: readonly { readonly account: string; readonly amount: bigint }[] }): Promise<void>;
}

export interface ResaleMetrics {
  increment(name: string, labels?: Readonly<Record<string, string>>): void;
}
export type { Proceeds };
