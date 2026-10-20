import type { sellerSettings as ss } from "@outlet/domain";

export type NotificationPrefs = ss.NotificationPrefs;

export interface ProfileRecord {
  readonly storeId: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly descriptionAr: string | null;
  readonly descriptionEn: string | null;
  readonly logoKey: string | null;
  readonly coverKey: string | null;
  readonly socialLinks: ss.SocialLinks;
  readonly returnPolicy: ss.ReturnPolicy;
  readonly freeDeliveryThreshold: bigint;
  readonly vacation: ss.Vacation;
  readonly version: number;
  readonly updatedBy: string | null;
  readonly updatedAtMs: number;
}

export interface UploadRecord {
  readonly id: string;
  readonly storeId: string;
  readonly slot: ss.ImageSlot;
  readonly objectKey: string;
  readonly contentType: ss.ImageType;
  readonly declaredBytes: number;
  readonly status: "issued" | "confirmed" | "rejected" | "expired";
  readonly rejectCode: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly createdBy: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

export interface PayoutAccountRecord {
  readonly id: string;
  readonly storeId: string;
  readonly accountToken: string;
  readonly ibanEnc: Uint8Array;
  readonly ibanLast4: string;
  readonly holderNameEnc: Uint8Array;
  readonly legalNameScore: number;
  readonly status: "ACTIVE" | "SUPERSEDED";
  readonly createdBy: string;
  readonly createdAtMs: number;
  readonly activatesAtMs: number;
}

export interface ShippingRecord {
  readonly storeId: string;
  readonly governorateCode: string;
  readonly cityCode: string;
  readonly street: string;
  readonly building: string | null;
  readonly landmark: string;
  readonly contactName: string;
  readonly contactPhoneEnc: Uint8Array;
  readonly pin: { readonly lat: number; readonly lng: number } | null;
  readonly handlingHours: number;
  readonly courierPreferences: ss.CourierPreferences;
  readonly packaging: readonly ss.PackagingOption[];
  readonly version: number;
  readonly updatedBy: string | null;
}

export interface InviteRecord {
  readonly id: string;
  readonly storeId: string;
  readonly role: ss.SellerTeamRole;
  readonly phoneBlind: Uint8Array;
  readonly phoneEnc: Uint8Array;
  readonly phoneMasked: string;
  readonly tokenHash: string;
  readonly status: ss.InviteState;
  readonly invitedBy: string;
  readonly respondedBy: string | null;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly respondedAtMs: number | null;
}

export interface EtaRecord {
  readonly storeId: string;
  readonly status: ss.EtaStatus;
  readonly failureCode: string | null;
  readonly requestedAtMs: number | null;
  readonly lastCheckedAtMs: number | null;
  readonly lastVerifiedAtMs: number | null;
}

export type SettingsArea = "profile" | "media" | "payout_account" | "shipping" | "notifications" | "team" | "eta";
export interface SettingsEvent {
  readonly id: string;
  readonly storeId: string;
  readonly area: SettingsArea;
  readonly kind: string;
  readonly actorId: string | null;
  readonly occurredAtMs: number;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
}

/** One repository for the whole module; each method is a single atomic statement or transaction. */
export interface SettingsRepository {
  getProfile(storeId: string): Promise<ProfileRecord | null>;
  /** Insert when `expectedVersion` is null, else update iff the stored version matches. False means conflict. */
  saveProfile(rec: ProfileRecord, expectedVersion: number | null): Promise<boolean>;

  createUpload(u: UploadRecord): Promise<void>;
  getUpload(storeId: string, id: string): Promise<UploadRecord | null>;
  markUpload(
    storeId: string,
    id: string,
    patch: { status: "confirmed" | "rejected"; rejectCode?: string; width?: number; height?: number; atMs: number },
  ): Promise<void>;

  activeAccount(storeId: string): Promise<PayoutAccountRecord | null>;
  /** Supersedes the active account (if any) and inserts `next` as ACTIVE, atomically. */
  replaceAccount(next: PayoutAccountRecord): Promise<void>;

  getShipping(storeId: string): Promise<ShippingRecord | null>;
  saveShipping(rec: ShippingRecord, expectedVersion: number | null): Promise<boolean>;

  getPrefs(storeId: string): Promise<NotificationPrefs>;
  savePrefs(storeId: string, prefs: NotificationPrefs, actorId: string, atMs: number): Promise<void>;

  insertInvite(inv: InviteRecord): Promise<"ok" | "duplicate_pending">;
  getInvite(storeId: string, id: string): Promise<InviteRecord | null>;
  getInviteByTokenHash(tokenHash: string): Promise<InviteRecord | null>;
  listInvites(storeId: string): Promise<readonly InviteRecord[]>;
  countPendingInvites(storeId: string, nowMs: number): Promise<number>;
  /** Moves a PENDING invite only; false when it is no longer pending (single use). */
  closeInvite(id: string, status: Exclude<ss.InviteState, "PENDING">, by: string | null, atMs: number): Promise<boolean>;

  getEta(storeId: string): Promise<EtaRecord | null>;
  saveEta(rec: EtaRecord, actorId: string, atMs: number): Promise<void>;

  addEvent(e: SettingsEvent): Promise<void>;
  listEvents(storeId: string, area: SettingsArea, limit: number): Promise<readonly SettingsEvent[]>;
}

// ------------------------------------------------------------------ outbound ports

export interface StoreIdentity {
  readonly slug: string;
  readonly kind: "local" | "global";
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly verifiedBadge: boolean;
  readonly legal: {
    readonly legalName: string;
    readonly commercialRegisterNo: string | null;
    readonly taxCardNo: string | null;
    readonly governorateCode: string | null;
  };
}
/** Approved application and store facts (B5 legal identity projection). */
export interface StoreIdentityPort {
  identity(storeId: string): Promise<StoreIdentity | null>;
}

export interface PlatformLimitsPort {
  freeDeliveryMax(): Promise<bigint>;
}

export interface SignedUpload {
  readonly url: string;
  readonly method: "PUT";
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAtMs: number;
}
/** Signed upload URL issuer. Production stays Unconfigured (503) until an object store is configured. */
export interface UploadStorePort {
  signPut(input: {
    readonly key: string;
    readonly contentType: string;
    readonly maxBytes: number;
    readonly ttlSeconds: number;
    readonly nowMs: number;
  }): Promise<SignedUpload>;
  publicUrl(key: string): string;
}

export interface InspectedObject {
  readonly byteSize: number;
  /** First bytes of the object (at least 64 KiB when present). */
  readonly head: Uint8Array;
  readonly malware: "clean" | "infected" | "pending";
}
/** Scan port: AV verdict plus raw facts for the magic-byte and dimension checks. */
export interface UploadScanPort {
  inspect(key: string): Promise<InspectedObject | null>;
}

export interface NameMatchPort {
  compare(holderName: string, legalName: string): Promise<ss.NameMatchScore>;
}

/** Wraps the seller auth helper assertRecentStrongFactor (module not landed yet). */
export interface StrongFactorPort {
  isRecent(input: { readonly userId: string; readonly nowMs: number; readonly maxAgeSec: number }): Promise<boolean>;
}

export interface MemberFacts {
  readonly userId: string;
  readonly role: ss.SellerTeamRole;
  readonly phoneE164: string | null;
  readonly joinedAtMs: number;
}
/** Seller auth owns memberships and grants; this module only asks it to create or change them. */
export interface SellerMembershipsAdminPort {
  listMembers(storeId: string): Promise<readonly MemberFacts[]>;
  phoneOf(userId: string): Promise<string | null>;
  createGrant(input: { readonly storeId: string; readonly userId: string; readonly role: ss.SellerTeamRole }): Promise<void>;
  changeRole(input: { readonly storeId: string; readonly userId: string; readonly role: ss.SellerTeamRole }): Promise<void>;
  removeMember(input: { readonly storeId: string; readonly userId: string }): Promise<void>;
}

export interface InviteDeliveryPort {
  deliver(input: {
    readonly phoneE164: string;
    readonly token: string;
    readonly storeId: string;
    readonly expiresAtMs: number;
  }): Promise<void>;
}

export interface EtaVerifierPort {
  verify(storeId: string): Promise<"verified" | "failed" | "unavailable">;
}

export interface FieldCipherPort {
  encrypt(plaintext: string, aad: string): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array, aad: string): Promise<string>;
  blindIndex(purpose: string, value: string): Promise<Uint8Array>;
}

/** PUBLIC port for the payouts module: the account payouts go to, and when it may be paid. */
export interface SellerPayoutAccountView {
  readonly accountToken: string;
  readonly ibanLast4: string;
  readonly legalName: string;
  /** Non-null while a replacement account is cooling: payouts to it stay held. */
  readonly holdUntilMs: number | null;
}
export interface SellerPayoutAccountPort {
  activeAccount(storeId: string, nowMs: number): Promise<SellerPayoutAccountView | null>;
}
