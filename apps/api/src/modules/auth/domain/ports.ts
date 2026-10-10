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

export interface User {
  readonly id: string;
  /** Null for accounts created through Apple, Google or a passkey before a phone is verified. */
  readonly phoneE164: string | null;
  readonly email: string | null;
  readonly language: UserLanguage;
  readonly status: "active";
  readonly createdAtMs: number;
}

export interface OtpChallengeRecord {
  readonly challenge: OtpChallenge;
  readonly channel: OtpChannel;
  /** Attested device key the code was sent for; verification must come from the same device. */
  readonly deviceKey: string;
}

export interface OtpChallengeRepository {
  find(id: string): Promise<OtpChallengeRecord | null>;
  insert(record: OtpChallengeRecord): Promise<void>;
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

export interface UserDirectory {
  findOrCreateByPhone(input: {
    phoneE164: string;
    language: UserLanguage;
    newId: string;
    nowMs: number;
  }): Promise<User>;
  /** Resolves `identities(provider, subject)`; creates the account on first sign-in. Never links by email. */
  findOrCreateByIdentity(input: {
    provider: "apple" | "google";
    subject: string;
    email: string | null;
    language: UserLanguage;
    newId: string;
    nowMs: number;
  }): Promise<User>;
  findById(id: string): Promise<User | null>;
}

export interface StoredSession {
  readonly session: Session;
  readonly family: RefreshFamily;
  readonly platform: "ios" | "android";
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
  markPassed(key: string, expiresAtMs: number): Promise<void>;
  hasPassed(key: string, nowMs: number): Promise<boolean>;
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
      readonly reason: "logout" | "reuse_detected" | "device_mismatch" | "user_revoked" | "clone_suspected";
      /** True when the user must be told (refresh reuse): the notification journey keys off this. */
      readonly notifyUser: boolean;
      readonly occurredAtMs: number;
    }
  | { readonly type: "user.age_blocked"; readonly occurredAtMs: number };

/**
 * Domain event sink. Production adapter: transactional outbox row in the same transaction as the
 * state change (A2.7); not built yet, the dev adapter keeps events in memory.
 */
export interface AuthEventPublisher {
  publish(event: AuthEvent): Promise<void>;
}
