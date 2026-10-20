import type { addresses } from "@outlet/domain";

/** Decrypted, derived address as the application layer sees it (never leaves the module raw). */
export interface AddressView {
  readonly id: string;
  readonly userId: string;
  readonly label?: string;
  readonly recipientName: string;
  readonly phoneE164: string;
  readonly governorateCode: string;
  readonly cityDistrictCode: string;
  readonly street: string;
  readonly building: string;
  readonly floor?: string;
  readonly apartment?: string;
  readonly landmark?: string;
  readonly mapPin?: addresses.MapPin;
  readonly courierCoverage: addresses.CourierCoverage;
  readonly codEligible: boolean;
  readonly qualityScore: number;
  readonly isDefault: boolean;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/** Stored form: P3 fields are ciphertext (AAD `address:<id>:<field>`), coverage and flags are derived at write time. */
export interface AddressRow {
  readonly id: string;
  readonly userId: string;
  readonly label: string | null;
  readonly recipientNameEnc: Uint8Array;
  readonly phoneEnc: Uint8Array;
  readonly phoneBlind: Uint8Array;
  readonly governorateCode: string;
  readonly cityCode: string;
  readonly streetEnc: Uint8Array;
  readonly buildingEnc: Uint8Array;
  readonly floorEnc: Uint8Array | null;
  readonly apartmentEnc: Uint8Array | null;
  readonly landmarkEnc: Uint8Array | null;
  readonly mapPinEnc: Uint8Array | null;
  readonly dedupeBlind: Uint8Array;
  readonly courierCoverage: addresses.CourierCoverage;
  readonly codEligible: boolean;
  readonly qualityScore: number;
  readonly isDefault: boolean;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/** Immutable copy taken at checkout (AAD `snapshot:<id>:<field>`). */
export interface SnapshotRow {
  readonly id: string;
  readonly userId: string;
  readonly orderRef: string;
  readonly sourceAddressId: string | null;
  readonly gift: boolean;
  readonly recipientNameEnc: Uint8Array;
  readonly phoneEnc: Uint8Array;
  readonly governorateCode: string;
  readonly cityCode: string;
  readonly streetEnc: Uint8Array;
  readonly buildingEnc: Uint8Array;
  readonly floorEnc: Uint8Array | null;
  readonly apartmentEnc: Uint8Array | null;
  readonly landmarkEnc: Uint8Array | null;
  readonly mapPinEnc: Uint8Array | null;
  readonly courierCoverage: addresses.CourierCoverage;
  readonly codEligible: boolean;
  readonly createdAtMs: number;
}

export interface GiftTokenRow {
  readonly tokenHash: Uint8Array;
  readonly ownerUserId: string;
  readonly addressId: string;
  readonly expiresAtMs: number;
  readonly revokedAtMs: number | null;
}

export interface GovernorateRow {
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string;
}
export interface CityRow extends GovernorateRow {
  readonly governorateCode: string;
}

/** Courier coverage reference data (admin-editable later). */
export interface CoverageSource {
  governorates(): Promise<readonly (GovernorateRow & { readonly covered: boolean })[]>;
  /** Null when the governorate code is unknown. */
  cities(governorateCode: string): Promise<readonly (CityRow & { readonly covered: boolean })[] | null>;
  entries(): Promise<readonly addresses.CoverageEntry[]>;
}

/** Operations inside one per-user serialized transaction. */
export interface AddressTx {
  /** Newest first. */
  all(): Promise<readonly AddressRow[]>;
  get(id: string): Promise<AddressRow | null>;
  insert(row: AddressRow): Promise<void>;
  update(row: AddressRow): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface AddressStore {
  /** Serialized per user (advisory lock / mutex) and atomic. Throws roll everything back. */
  run<T>(userId: string, fn: (tx: AddressTx) => Promise<T>): Promise<T>;
  /** Keyset page ordered by (createdAt desc, id desc). */
  page(userId: string, after: { readonly createdAtMs: number; readonly id: string } | null, limit: number): Promise<readonly AddressRow[]>;
  find(userId: string, id: string): Promise<AddressRow | null>;
  readonly coverage: CoverageSource;
  /** Idempotent on (userId, orderRef): a replay returns the stored row unchanged. */
  insertSnapshot(row: SnapshotRow): Promise<SnapshotRow>;
  findSnapshot(id: string): Promise<SnapshotRow | null>;
  insertGiftToken(row: GiftTokenRow): Promise<void>;
  findGiftToken(tokenHash: Uint8Array): Promise<GiftTokenRow | null>;
  revokeGiftToken(ownerUserId: string, tokenHash: Uint8Array, atMs: number): Promise<boolean>;
}
