/**
 * DEVELOPMENT FIXTURES for the auth module. Everything here is in-memory, per process, lost on
 * restart and not safe for production:
 *  - DevOtpSender does not contact any SMS or WhatsApp provider; codes land in a mailbox that
 *    tests and local tooling read. It never logs a code.
 *  - DevAttestationVerifier accepts a literal fixture token. It does NOT verify App Attest or
 *    Play Integrity and must never be reachable in production (config refuses fixtures there).
 *  - DevTokenService issues opaque random bearer strings, not signed JWTs.
 */
import type { AccessClaims, AttestationVerdict, AttestationVerifier, Csprng, OtpChannel, OtpSender, OtpSendRequest, OtpSendResult, SendHistory } from "@outlet/auth-core";
import { checkAccessClaims, toHex } from "@outlet/auth-core";
import type { Actor, Resource } from "@outlet/policy";
import type {
  AccessTokenIssuer,
  AgePassInfo,
  OtpChallengeRecord,
  OtpChallengeRepository,
  OtpSendLog,
  SessionRepository,
  StoredSession,
  User,
  UserDirectory,
  UserLanguage,
} from "../domain/ports";
import { AccountUnavailableError } from "../domain/ports";
import type { OtpChallenge } from "@outlet/auth-core";
import type { SellerActorResolver } from "../seller/domain/ports";

export interface DevMailboxEntry {
  readonly phoneE164: string;
  readonly code: string;
  readonly channel: OtpChannel;
}

export class DevOtpMailbox {
  readonly entries: DevMailboxEntry[] = [];
  last(phoneE164: string): DevMailboxEntry | undefined {
    return [...this.entries].reverse().find((e) => e.phoneE164 === phoneE164);
  }
}

export class DevOtpSender implements OtpSender {
  constructor(
    readonly channel: OtpChannel,
    private readonly mailbox: DevOtpMailbox,
  ) {}
  get id(): string {
    return `dev-fixture-${this.channel}`;
  }
  async send(request: OtpSendRequest): Promise<OtpSendResult> {
    this.mailbox.entries.push({ phoneE164: request.phoneE164, code: request.code, channel: this.channel });
    return { ok: true, providerMessageId: `dev-${this.mailbox.entries.length}` };
  }
}

export const DEV_ATTESTATION_PREFIX = "dev-fixture-attest:";

export class DevAttestationVerifier implements AttestationVerifier {
  async verify(input: { platform: "ios_app_attest" | "android_play_integrity"; token: string; challenge: string }): Promise<AttestationVerdict> {
    if (!input.token.startsWith(DEV_ATTESTATION_PREFIX)) return { ok: false, reason: "invalid_token" };
    const keyId = input.token.slice(DEV_ATTESTATION_PREFIX.length);
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(keyId)) return { ok: false, reason: "invalid_token" };
    return { ok: true, platform: input.platform, keyId };
  }
}

export class InMemoryOtpChallengeRepository implements OtpChallengeRepository {
  private readonly rows = new Map<string, OtpChallengeRecord>();

  async find(id: string): Promise<OtpChallengeRecord | null> {
    return this.rows.get(id) ?? null;
  }
  async insert(record: OtpChallengeRecord): Promise<void> {
    this.rows.set(record.challenge.id, record);
  }
  async deviceKeyOf(deviceKey: string): Promise<string> {
    return deviceKey;
  }
  async compareAndSet(previous: OtpChallenge, next: OtpChallengeRecord): Promise<boolean> {
    const cur = this.rows.get(previous.id);
    if (cur === undefined || cur.challenge.attempts !== previous.attempts || cur.challenge.status !== previous.status) {
      return false;
    }
    this.rows.set(previous.id, next);
    return true;
  }
}

export class InMemoryOtpSendLog implements OtpSendLog {
  private readonly byPhone = new Map<string, number[]>();
  private readonly byDevice = new Map<string, number[]>();

  async history(phoneE164: string, deviceKey: string): Promise<SendHistory> {
    return { phoneSendTimes: this.byPhone.get(phoneE164) ?? [], deviceSendTimes: this.byDevice.get(deviceKey) ?? [] };
  }
  async record(phoneE164: string, deviceKey: string, nowMs: number): Promise<void> {
    this.byPhone.set(phoneE164, [...(this.byPhone.get(phoneE164) ?? []), nowMs]);
    this.byDevice.set(deviceKey, [...(this.byDevice.get(deviceKey) ?? []), nowMs]);
  }
}

export class InMemoryUserDirectory implements UserDirectory {
  private readonly byId = new Map<string, User>();
  private readonly byPhone = new Map<string, string>();

  async findByPhone(phoneE164: string): Promise<User | null> {
    const id = this.byPhone.get(phoneE164);
    const u = id === undefined ? undefined : this.byId.get(id);
    return u !== undefined && u.status === "active" ? u : null;
  }

  /** Test helper: suspends an account (findByPhone then reports no active account). */
  suspendForTest(id: string): void {
    const u = this.byId.get(id);
    if (u !== undefined) this.byId.set(id, { ...u, status: "suspended" as unknown as User["status"] });
  }

  /** Test helper: number of accounts (asserts that a sign-in-only verify created none). */
  get size(): number {
    return this.byId.size;
  }

  async findOrCreateByPhone(input: { phoneE164: string; language: UserLanguage; newId: string; nowMs: number; age?: AgePassInfo | null }): Promise<User> {
    const existingId = this.byPhone.get(input.phoneE164);
    const existing = existingId === undefined ? undefined : this.byId.get(existingId);
    if (existing !== undefined) {
      if (existing.status !== "active") throw new AccountUnavailableError();
      return existing;
    }
    const user: User = {
      id: input.newId,
      phoneE164: input.phoneE164,
      email: null,
      language: input.language,
      status: "active",
      createdAtMs: input.nowMs,
      ageBand: input.age?.ageBand ?? null,
      limitedCapacity: input.age?.ageBand === "18_20",
    };
    this.byId.set(user.id, user);
    this.byPhone.set(input.phoneE164, user.id);
    return user;
  }
  private readonly byIdentity = new Map<string, string>();

  async findOrCreateByIdentity(input: {
    provider: "apple" | "google";
    subject: string;
    email: string | null;
    language: UserLanguage;
    newId: string;
    nowMs: number;
    age?: AgePassInfo | null;
  }): Promise<User> {
    const key = `${input.provider}:${input.subject}`;
    const existingId = this.byIdentity.get(key);
    const existing = existingId === undefined ? undefined : this.byId.get(existingId);
    if (existing !== undefined) {
      // Same as the Kysely adapter: a suspended identity is never reused or re-created.
      if (existing.status !== "active") throw new AccountUnavailableError();
      return existing;
    }
    const user: User = {
      id: input.newId,
      phoneE164: null,
      email: input.email,
      language: input.language,
      status: "active",
      createdAtMs: input.nowMs,
      ageBand: input.age?.ageBand ?? null,
      limitedCapacity: input.age?.ageBand === "18_20",
    };
    this.byId.set(user.id, user);
    this.byIdentity.set(key, user.id);
    return user;
  }
  async findByIdentity(provider: "apple" | "google", subject: string): Promise<User | null> {
    const id = this.byIdentity.get(`${provider}:${subject}`);
    const u = id === undefined ? undefined : this.byId.get(id);
    return u !== undefined && u.status === "active" ? u : null;
  }
  /** Active accounts only, like the Kysely adapter (`status = 'active'`). */
  async findById(id: string): Promise<User | null> {
    const u = this.byId.get(id);
    return u !== undefined && u.status === "active" ? u : null;
  }
}

export class InMemorySessionRepository implements SessionRepository {
  private readonly rows = new Map<string, StoredSession>();
  /** Test helper: number of sessions (asserts that a refused sign-in opened none). */
  get size(): number {
    return this.rows.size;
  }
  async insert(stored: StoredSession): Promise<void> {
    this.rows.set(stored.session.id, stored);
  }
  async find(sessionId: string): Promise<StoredSession | null> {
    return this.rows.get(sessionId) ?? null;
  }
  async save(stored: StoredSession): Promise<void> {
    this.rows.set(stored.session.id, stored);
  }
  async compareAndSave(previous: StoredSession, next: StoredSession): Promise<boolean> {
    const cur = this.rows.get(previous.session.id);
    if (
      cur === undefined ||
      cur.family.records.length !== previous.family.records.length ||
      cur.family.revokedAtMs !== previous.family.revokedAtMs ||
      cur.session.revokedAtMs !== previous.session.revokedAtMs
    ) {
      return false;
    }
    this.rows.set(next.session.id, next);
    return true;
  }
  async findByRefreshHash(tokenHash: string): Promise<StoredSession | null> {
    for (const row of this.rows.values()) {
      if (row.family.records.some((r) => r.tokenHash === tokenHash)) return row;
    }
    return null;
  }
  async listByUser(userId: string): Promise<readonly StoredSession[]> {
    return [...this.rows.values()].filter((r) => r.session.userId === userId);
  }
}

/** Issues and verifies opaque dev bearer tokens. Verification also requires a live session. */
export class DevTokenService implements AccessTokenIssuer {
  private readonly claimsByToken = new Map<string, AccessClaims>();

  constructor(
    private readonly rng: Csprng,
    private readonly sessions: SessionRepository,
    private readonly users: UserDirectory,
    private readonly sellerActors?: SellerActorResolver,
  ) {}

  async issue(claims: AccessClaims): Promise<string> {
    const token = `dev_${toHex(this.rng.randomBytes(32))}`;
    this.claimsByToken.set(token, claims);
    return token;
  }

  async authenticate(token: string, nowMs: number): Promise<{ actor: Actor; claims: AccessClaims } | null> {
    const raw = this.claimsByToken.get(token);
    if (raw === undefined) return null;
    const checked = checkAccessClaims(raw, raw.aud, nowMs);
    if (!checked.ok) return null;
    if (checked.claims.aud === "seller_api") {
      if (this.sellerActors === undefined) return null;
      const actor = await this.sellerActors.resolve(checked.claims, nowMs);
      return actor === null ? null : { claims: checked.claims, actor };
    }
    const stored = await this.sessions.find(checked.claims.sid);
    if (stored === null || stored.session.revokedAtMs !== null) return null;
    const user = await this.users.findById(checked.claims.sub);
    if (user === null) return null;
    return {
      claims: checked.claims,
      actor: { id: user.id, status: user.status, assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] },
    };
  }
}

export class SessionResourceResolver {
  constructor(private readonly sessions: SessionRepository) {}

  async resolve(input: { id: string | undefined }): Promise<Resource | null> {
    if (input.id === undefined || input.id.length > 64) return null;
    const s = await this.sessions.find(input.id);
    if (s === null) return null;
    return {
      type: "session",
      id: s.session.id,
      ownerUserId: s.session.userId,
      state: s.session.revokedAtMs === null ? "active" : "deleted",
    };
  }
}
