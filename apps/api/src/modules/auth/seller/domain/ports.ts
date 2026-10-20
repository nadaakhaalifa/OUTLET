import type { AccessClaims, Amr, OtpChallenge, OtpChannel, RefreshFamily } from "@outlet/auth-core";
import type { Actor, BrandRole, Grant } from "@outlet/policy";
import type { UserLanguage } from "../../domain/ports";

/** Seller identity: separate from the shopper `User` (ADR-0031, decision 1). */
export interface SellerUser {
  readonly id: string;
  readonly phoneE164: string;
  readonly email: string | null;
  readonly language: UserLanguage;
  readonly status: "active" | "suspended";
  /** True once a passkey or a confirmed TOTP exists. Gates every full session. */
  readonly strongFactor: boolean;
  /** Set only after the same phone passed OTP in both audiences; never merges the accounts. */
  readonly shopperUserId: string | null;
  readonly createdAtMs: number;
}

export interface SellerUserDirectory {
  /** Creates the identity on first verified OTP, else returns the existing one. Never overwrites email. */
  findOrCreateByPhone(input: {
    phoneE164: string;
    email: string | null;
    language: UserLanguage;
    newId: string;
    nowMs: number;
  }): Promise<SellerUser>;
  findById(id: string): Promise<SellerUser | null>;
  findByPhone(phoneE164: string): Promise<SellerUser | null>;
  markStrongFactor(id: string): Promise<void>;
  linkShopper(id: string, shopperUserId: string): Promise<void>;
}

export interface SellerOtpRecord {
  readonly challenge: OtpChallenge;
  readonly channel: OtpChannel;
  /** Raw client key (attested device key or `ip:<addr>`); stores may keep only a keyed hash. */
  readonly clientKey: string;
  readonly email: string | null;
  readonly language: UserLanguage;
}

export interface SellerOtpChallengeRepository {
  find(id: string): Promise<SellerOtpRecord | null>;
  insert(record: SellerOtpRecord): Promise<void>;
  clientKeyOf(clientKey: string): Promise<string>;
  compareAndSet(previous: OtpChallenge, next: SellerOtpRecord): Promise<boolean>;
}

export interface SellerOtpSendHistory {
  readonly phoneSendTimes: readonly number[];
  readonly clientSendTimes: readonly number[];
  /** Sends to the same calling-code prefix in the cap window, and how many of them were verified. */
  readonly prefixSends: number;
  readonly prefixVerified: number;
}

export interface SellerOtpSendLog {
  history(phoneE164: string, clientKey: string, prefix: string, nowMs: number, prefixWindowMs: number): Promise<SellerOtpSendHistory>;
  record(phoneE164: string, clientKey: string, prefix: string, nowMs: number): Promise<void>;
  markVerified(phoneE164: string, nowMs: number): Promise<void>;
}

export interface OtpProof {
  readonly sellerUserId: string;
  readonly channel: OtpChannel;
}

/** Single-use, 5 minute proof that the seller's phone was just verified. Only a hash is stored. */
export interface SellerOtpProofStore {
  put(proofHash: string, proof: OtpProof, expiresAtMs: number): Promise<void>;
  /** Atomic: returns the proof once and marks it consumed. */
  consume(proofHash: string, nowMs: number): Promise<OtpProof | null>;
  /** Non-consuming read (TOTP assert keeps the proof until the code is right or the seller is locked). */
  peek(proofHash: string, nowMs: number): Promise<OtpProof | null>;
}

// ---- Passkeys -----------------------------------------------------------------------------

export interface SellerPasskeyChallenge {
  readonly id: string;
  readonly challenge: string;
  readonly purpose: "register" | "assert";
  readonly sellerUserId: string;
  readonly otpChannel: OtpChannel | null;
  readonly expiresAtMs: number;
}

export interface SellerPasskeyChallengeStore {
  put(record: SellerPasskeyChallenge): Promise<void>;
  take(id: string, nowMs: number): Promise<SellerPasskeyChallenge | null>;
  peek(id: string, nowMs: number): Promise<SellerPasskeyChallenge | null>;
}

export interface SellerPasskey {
  readonly sellerUserId: string;
  readonly credentialId: string;
  readonly publicKey: string;
  readonly signCount: number;
  readonly backupEligible: boolean;
  readonly backedUp: boolean;
  readonly status: "active" | "suspected_clone";
  readonly label: string | null;
  readonly createdAtMs: number;
}

export interface SellerPasskeyRepository {
  insert(passkey: SellerPasskey): Promise<boolean>;
  find(credentialId: string): Promise<SellerPasskey | null>;
  update(passkey: SellerPasskey): Promise<void>;
  listActive(sellerUserId: string): Promise<readonly SellerPasskey[]>;
}

// ---- TOTP ---------------------------------------------------------------------------------

export interface SellerTotpRecord {
  readonly sellerUserId: string;
  /** Base32 secret, decrypted by the store through the FieldCipher. */
  readonly secretBase32: string;
  readonly status: "pending" | "active";
  readonly lastUsedStep: number | null;
  readonly failedCount: number;
  readonly lockCount: number;
  readonly lockedUntilMs: number | null;
  readonly createdAtMs: number;
}

export interface SellerTotpStore {
  find(sellerUserId: string): Promise<SellerTotpRecord | null>;
  /** Replaces a pending enrolment (and its recovery codes); refuses when an active one exists. */
  startEnrolment(record: SellerTotpRecord, recoveryHashes: readonly string[]): Promise<boolean>;
  /** Compare-and-set on `lastUsedStep` (replay prevention across concurrent requests). */
  acceptStep(sellerUserId: string, step: number, previousStep: number | null, activate: boolean, nowMs: number): Promise<boolean>;
  recordFailure(sellerUserId: string, failedCount: number, lockCount: number, lockedUntilMs: number | null): Promise<void>;
  resetFailures(sellerUserId: string): Promise<void>;
  /** Atomic single use: true only for the first call with an unused hash. */
  consumeRecoveryCode(sellerUserId: string, codeHash: string, nowMs: number): Promise<boolean>;
  remainingRecoveryCodes(sellerUserId: string): Promise<number>;
}

// ---- Sessions -----------------------------------------------------------------------------

export interface SellerSessionRecord {
  readonly id: string;
  readonly sellerUserId: string;
  readonly kind: "enrol" | "full";
  /** Enrol token of an identity that already has a strong factor: reaches nothing but logout. */
  readonly restricted: boolean;
  readonly installId: string;
  readonly amr: readonly Amr[];
  readonly strongAtMs: number | null;
  readonly createdAtMs: number;
  readonly lastUsedAtMs: number;
  readonly expiresAtMs: number | null;
  readonly revokedAtMs: number | null;
}

export interface StoredSellerSession {
  readonly session: SellerSessionRecord;
  /** Null for enrol sessions (not refreshable). */
  readonly family: RefreshFamily | null;
}

export interface SellerSessionRepository {
  insert(stored: StoredSellerSession): Promise<void>;
  find(sessionId: string): Promise<StoredSellerSession | null>;
  save(stored: StoredSellerSession): Promise<void>;
  findByRefreshHash(tokenHash: string): Promise<StoredSellerSession | null>;
  compareAndSave(previous: StoredSellerSession, next: StoredSellerSession): Promise<boolean>;
  listBySeller(sellerUserId: string): Promise<readonly StoredSellerSession[]>;
}

// ---- Memberships --------------------------------------------------------------------------

export interface SellerMembership {
  readonly id: string;
  readonly sellerUserId: string;
  readonly storeId: string;
  readonly role: BrandRole;
  readonly grantedBy: string | null;
  readonly createdAtMs: number;
}

export interface SellerMembershipRepository {
  /** Idempotent: an active membership for (seller, store) is updated to `role`. Returns the row. */
  upsert(input: { id: string; sellerUserId: string; storeId: string; role: BrandRole; grantedBy: string | null; nowMs: number }): Promise<SellerMembership>;
  /** Revokes unless it is the store's last owner. Returns false when nothing was revoked. */
  revoke(input: { sellerUserId: string; storeId: string; nowMs: number }): Promise<"revoked" | "not_found" | "last_owner">;
  listBySeller(sellerUserId: string): Promise<readonly SellerMembership[]>;
  listByStore(storeId: string): Promise<readonly SellerMembership[]>;
}

export interface SellerInvite {
  readonly id: string;
  readonly storeId: string;
  readonly role: BrandRole;
  readonly phoneE164: string;
  readonly invitedBy: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

export interface SellerInviteRepository {
  /** One open invite per (store, phone): re-inviting replaces the role and the expiry. */
  upsertOpen(invite: SellerInvite): Promise<SellerInvite>;
  listOpenByPhone(phoneE164: string, nowMs: number): Promise<readonly SellerInvite[]>;
  markAccepted(id: string, nowMs: number): Promise<void>;
  revoke(storeId: string, phoneE164: string, nowMs: number): Promise<boolean>;
}

// ---- Events -------------------------------------------------------------------------------

export type SellerAuthEvent =
  | { readonly type: "seller.session_revoked"; readonly sellerUserId: string; readonly sessionId: string; readonly reason: string; readonly notifySeller: boolean; readonly occurredAtMs: number }
  | { readonly type: "seller.strong_factor_enrolled"; readonly sellerUserId: string; readonly method: "webauthn" | "totp"; readonly occurredAtMs: number }
  | { readonly type: "seller.totp_locked"; readonly sellerUserId: string; readonly lockedUntilMs: number; readonly occurredAtMs: number }
  | { readonly type: "seller.recovery_code_used"; readonly sellerUserId: string; readonly remaining: number; readonly occurredAtMs: number }
  | { readonly type: "seller.otp_prefix_anomaly"; readonly prefix: string; readonly reason: string; readonly occurredAtMs: number }
  | { readonly type: "seller.membership_granted"; readonly sellerUserId: string; readonly storeId: string; readonly role: BrandRole; readonly occurredAtMs: number }
  | { readonly type: "seller.membership_revoked"; readonly sellerUserId: string; readonly storeId: string; readonly occurredAtMs: number };

export interface SellerAuthEvents {
  publish(event: SellerAuthEvent): Promise<void>;
}

// ---- Public read ports --------------------------------------------------------------------

/** What the rest of the API may ask the seller auth module (exported from the auth index). */
export interface SellerMembershipsPort {
  list(sellerUserId: string): Promise<readonly { readonly storeId: string; readonly role: BrandRole }[]>;
  /** Brand grants for the policy layer. */
  grantsFor(sellerUserId: string): Promise<readonly Grant[]>;
}

/** Turns verified seller claims into a policy actor; null when the session or identity is not usable. */
export interface SellerActorResolver {
  resolve(claims: AccessClaims, nowMs: number): Promise<Actor | null>;
}

export interface SellerStores {
  readonly users: SellerUserDirectory;
  readonly challenges: SellerOtpChallengeRepository;
  readonly sendLog: SellerOtpSendLog;
  readonly proofs: SellerOtpProofStore;
  readonly passkeyChallenges: SellerPasskeyChallengeStore;
  readonly passkeys: SellerPasskeyRepository;
  readonly totp: SellerTotpStore;
  readonly sessions: SellerSessionRepository;
  readonly memberships: SellerMembershipRepository;
  readonly invites: SellerInviteRepository;
}
