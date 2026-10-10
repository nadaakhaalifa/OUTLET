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
  readonly phoneE164: string;
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
}

/** Turns claims into a bearer token. Production: JWT signed with a KMS key (not built yet). */
export interface AccessTokenIssuer {
  issue(claims: AccessClaims): Promise<string>;
}
