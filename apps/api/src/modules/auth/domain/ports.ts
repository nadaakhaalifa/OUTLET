import type {
  AccessClaims,
  OtpChallenge,
  OtpChannel,
  RefreshFamily,
  SendHistory,
  Session,
} from "@outlet/auth-core";

/** Language codes domain packages distinguish. The wire locale is mapped at the HTTP edge. */
export type UserLanguage = "ar" | "en";

export type AgeBand = "18_20" | "21_plus";

/** What a passed age gate leaves behind for the account created right after it (no DOB in clear). */
export interface AgePassInfo {
  readonly ageBand: AgeBand;
  /** Envelope-encrypted YYYY-MM-DD (P3); null when no cipher is configured (dev fixtures). */
  readonly dobCiphertext: Uint8Array | null;
}

/**
 * Field-level envelope encryption and keyed blind indexes for P2/P3 columns (spec T5, ADR-0002).
 * Production adapter: KMS-managed data keys (`kms.envelope`, Unconfigured until a KMS is chosen,
 * so every call fails closed with 503). `aad` binds a ciphertext to its column.
 */
export interface FieldCipher {
  encrypt(plaintext: string, aad: string): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array, aad: string): Promise<string>;
  /** 32-byte HMAC blind index, domain separated by `purpose` (e.g. "phone", "otp-device"). */
  blindIndex(purpose: string, value: string): Promise<Uint8Array>;
}

export interface User {
  readonly id: string;
  /** Null for accounts created through Apple, Google or a passkey before a phone is verified. */
  readonly phoneE164: string | null;
  readonly email: string | null;
  readonly language: UserLanguage;
  readonly status: "active";
  readonly createdAtMs: number;
  /** Null for accounts created before the age band was recorded. */
  readonly ageBand: AgeBand | null;
  /** True for 18 to 20 year olds (spec B6): soft gates on 21+ capabilities. */
  readonly limitedCapacity: boolean;
}

export interface OtpChallengeRecord {
  readonly challenge: OtpChallenge;
  readonly channel: OtpChannel;
  /** Attested device key the code was sent for; verification must come from the same device. */
  readonly deviceKey: string;
}

export interface OtpChallengeRepository {
  find(id: string): Promise<OtpChallengeRecord | null>;
  /** `record.deviceKey` is the raw attested key; stores may keep only a keyed hash of it. */
  insert(record: OtpChallengeRecord): Promise<void>;
  /** The value `find().deviceKey` carries for this raw attested key (identity, or a keyed hash). */
  deviceKeyOf(deviceKey: string): Promise<string>;
  /**
   * Optimistic update. Succeeds only if the stored challenge still equals `previous` on
   * (attempts, status), so two concurrent verifications cannot both consume one code.
   */
  compareAndSet(previous: OtpChallenge, next: OtpChallengeRecord): Promise<boolean>;
}

export interface OtpSendLog {
  history(phoneE164: string, deviceKey: string, nowMs: number): Promise<SendHistory>;
  record(phoneE164: string, deviceKey: string, nowMs: number): Promise<void>;
}

/** The identity exists but its account is not active (for example suspended). Create mode must not create or reuse it. */
export class AccountUnavailableError extends Error {
  constructor() {
    super("account unavailable");
    this.name = "AccountUnavailableError";
  }
}

export interface UserDirectory {
  findOrCreateByPhone(input: {
    phoneE164: string;
    language: UserLanguage;
    newId: string;
    nowMs: number;
    age?: AgePassInfo | null;
  }): Promise<User>;
  /** Resolves `identities(provider, subject)`; creates the account on first sign-in. Never links by email. */
  findOrCreateByIdentity(input: {
    provider: "apple" | "google";
    subject: string;
    email: string | null;
    language: UserLanguage;
    newId: string;
    nowMs: number;
    age?: AgePassInfo | null;
  }): Promise<User>;
  /** Read only: resolves an existing active account by verified phone; never creates anything. */
  findByPhone(phoneE164: string): Promise<User | null>;
  /**
   * Read only: resolves `identities(provider, subject)` to an existing ACTIVE account; never creates anything.
   * A suspended account answers null (same as unknown), like findByPhone.
   */
  findByIdentity(provider: "apple" | "google", subject: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
}

export type SessionPlatform = "ios" | "android" | "web";

export interface StoredSession {
  readonly session: Session;
  readonly family: RefreshFamily;
  readonly platform: SessionPlatform;
  /**
   * True only when a passkey assertion opened the session and the verifier checked user
   * verification (auth_sessions.uv, migration 0092). Absent means false.
   */
  readonly uv?: boolean;
  /**
   * Web sessions only: hex SHA-256 of the server-minted browser install token held by the session's
   * device row (devices.install_secret_hash). Null once that device is revoked by a newer login.
   * The token itself is never stored.
   */
  readonly installSecretHash?: string | null;
  /**
   * Keyed hash of the ATTESTED device key (App Attest / Play Integrity) the session was opened from
   * (auth_sessions.device_key_hash, migration 0099). Absent or null = unknown (sessions created before the
   * column, web sessions, or no attested key on the path): the recycled-number step-up treats it as NOT known.
   */
  readonly deviceKeyHash?: string | null;
}

/**
 * Whether a user holds at least one unexpired standing admin grant. The auth module only asks the
 * yes/no question for the web sign-in gate (deny by default); roles are decided elsewhere. The
 * production binding is Unconfigured (answers false) until a grant source is composed.
 */
export interface AdminGrantReader {
  hasStandingAdminGrant(userId: string, nowMs: number): Promise<boolean>;
}

export interface SessionRepository {
  insert(stored: StoredSession): Promise<void>;
  find(sessionId: string): Promise<StoredSession | null>;
  save(stored: StoredSession): Promise<void>;
  /** Looks a session up by the SHA-256 of any refresh token it ever issued (rotated ones included, for reuse detection). */
  findByRefreshHash(tokenHash: string): Promise<StoredSession | null>;
  /**
   * Optimistic write: succeeds only when the stored row still has the same refresh records and
   * revocation state as `previous`, so two concurrent rotations cannot both succeed.
   */
  compareAndSave(previous: StoredSession, next: StoredSession): Promise<boolean>;
  listByUser(userId: string): Promise<readonly StoredSession[]>;
}

/** Turns claims into a bearer token. Production: JWT signed with a KMS key (not built yet). */
export interface AccessTokenIssuer {
  issue(claims: AccessClaims): Promise<string>;
}

// ---- Age gate (spec 1, B6) ---------------------------------------------------------------

/**
 * Server-side store for the under-18 block and the "gate passed" marker. Keys are HMACs (never
 * a DOB, a plain hash of one, or a raw device id). Values carry no personal data.
 */
export interface AgeGateStore {
  /** Latest `blockedUntilMs` over the given keys, or null when none is blocked at `nowMs`. */
  activeBlock(keys: readonly string[], nowMs: number): Promise<number | null>;
  block(keys: readonly string[], untilMs: number): Promise<void>;
  markPassed(key: string, expiresAtMs: number, info?: AgePassInfo): Promise<void>;
  hasPassed(key: string, nowMs: number): Promise<boolean>;
  /** The band (and encrypted DOB) recorded with a still valid pass; null when none. */
  passInfo(key: string, nowMs: number): Promise<AgePassInfo | null>;
}

// ---- Federated identity ---------------------------------------------------------------

/** Remembers consumed ID-token nonces so a captured token cannot be replayed. Atomic. */
export interface NonceStore {
  /** True when the nonce was fresh and is now consumed; false when it was already used. */
  consume(key: string, expiresAtMs: number, nowMs: number): Promise<boolean>;
}

// ---- Passkeys -------------------------------------------------------------------------

export interface PasskeyChallengeRecord {
  readonly id: string;
  readonly challenge: string;
  readonly purpose: "register" | "assert";
  /** Set for registration (bound to the signed-in user); null for sign-in (usernameless). */
  readonly userId: string | null;
  readonly expiresAtMs: number;
}

export interface PasskeyChallengeStore {
  put(record: PasskeyChallengeRecord): Promise<void>;
  /** Atomic read-and-delete: a challenge can be consumed at most once. Expired ones are not returned. */
  take(id: string, nowMs: number): Promise<PasskeyChallengeRecord | null>;
  /** Returns the record without consuming it (ownership checks). */
  peek(id: string, nowMs: number): Promise<PasskeyChallengeRecord | null>;
}

export interface StoredPasskey {
  readonly userId: string;
  readonly credentialId: string;
  readonly publicKey: string;
  readonly signCount: number;
  readonly backupEligible?: boolean;
  readonly backedUp?: boolean;
  readonly status: "active" | "suspected_clone";
  readonly createdAtMs: number;
}

export interface PasskeyCredentialRepository {
  insert(passkey: StoredPasskey): Promise<boolean>;
  find(credentialId: string): Promise<StoredPasskey | null>;
  update(passkey: StoredPasskey): Promise<void>;
}

// ---- Events ---------------------------------------------------------------------------

export type AuthEvent =
  | {
      readonly type: "session.revoked";
      readonly sessionId: string;
      readonly userId: string;
      readonly familyId: string;
      readonly reason: "logout" | "reuse_detected" | "device_mismatch" | "user_revoked" | "clone_suspected" | "web_login_rotated";
      /** True when the user must be told (refresh reuse): the notification journey keys off this. */
      readonly notifyUser: boolean;
      readonly occurredAtMs: number;
    }
  | { readonly type: "user.age_blocked"; readonly occurredAtMs: number }
  /** Recycled-number step-up demanded (no session issued). No PII: the install id is a SHA-256 hash. */
  | { readonly type: "auth.step_up_required"; readonly userId: string; readonly installIdHash: string; readonly occurredAtMs: number }
  /** The step-up passkey assertion succeeded and a session was opened. */
  | { readonly type: "auth.step_up_completed"; readonly userId: string; readonly installIdHash: string; readonly occurredAtMs: number };

/**
 * Domain event sink. Production adapter: transactional outbox row in the same transaction as the
 * state change (A2.7); not built yet, the dev adapter keeps events in memory.
 */
export interface AuthEventPublisher {
  publish(event: AuthEvent): Promise<void>;
}
