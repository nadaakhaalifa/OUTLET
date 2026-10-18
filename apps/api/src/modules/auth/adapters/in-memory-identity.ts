/**
 * DEVELOPMENT FIXTURES for age gate, nonce store, passkey stores, events and the passkey
 * verifier. In-memory, per process, not safe for production (config refuses fixtures there).
 */
import type {
  PasskeyCredential,
  PasskeyResult,
  PasskeyVerifier,
} from "@outlet/auth-core";
import type {
  AdminGrantReader,
  AgeGateStore,
  AgePassInfo,
  AuthEvent,
  AuthEventPublisher,
  NonceStore,
  PasskeyChallengeRecord,
  PasskeyChallengeStore,
  PasskeyCredentialRepository,
  StoredPasskey,
} from "../domain/ports";

export class InMemoryAgeGateStore implements AgeGateStore {
  private readonly blocks = new Map<string, number>();
  private readonly passed = new Map<string, number>();
  private readonly info = new Map<string, AgePassInfo>();

  async activeBlock(keys: readonly string[], nowMs: number): Promise<number | null> {
    let latest: number | null = null;
    for (const k of keys) {
      const until = this.blocks.get(k);
      if (until !== undefined && until > nowMs && (latest === null || until > latest)) latest = until;
    }
    return latest;
  }
  async block(keys: readonly string[], untilMs: number): Promise<void> {
    for (const k of keys) this.blocks.set(k, Math.max(this.blocks.get(k) ?? 0, untilMs));
  }
  async markPassed(key: string, expiresAtMs: number, info?: AgePassInfo): Promise<void> {
    this.passed.set(key, expiresAtMs);
    if (info !== undefined) this.info.set(key, info);
  }
  async passInfo(key: string, nowMs: number): Promise<AgePassInfo | null> {
    return (this.passed.get(key) ?? 0) > nowMs ? (this.info.get(key) ?? null) : null;
  }
  async hasPassed(key: string, nowMs: number): Promise<boolean> {
    return (this.passed.get(key) ?? 0) > nowMs;
  }
  /** Test support only: grants a pass synchronously. */
  grantPassForTest(key: string, expiresAtMs: number): void {
    this.passed.set(key, expiresAtMs);
  }
  /** Test support only: what is stored, to prove no personal data is kept. */
  snapshotForTest(): { blocks: [string, number][]; passed: [string, number][] } {
    return { blocks: [...this.blocks], passed: [...this.passed] };
  }
}

export class InMemoryNonceStore implements NonceStore {
  private readonly seen = new Map<string, number>();
  async consume(key: string, expiresAtMs: number, nowMs: number): Promise<boolean> {
    for (const [k, exp] of this.seen) if (exp <= nowMs) this.seen.delete(k);
    if (this.seen.has(key)) return false;
    this.seen.set(key, expiresAtMs);
    return true;
  }
}

export class InMemoryPasskeyChallengeStore implements PasskeyChallengeStore {
  private readonly rows = new Map<string, PasskeyChallengeRecord>();
  async put(record: PasskeyChallengeRecord): Promise<void> {
    this.rows.set(record.id, record);
  }
  async take(id: string, nowMs: number): Promise<PasskeyChallengeRecord | null> {
    const r = this.rows.get(id);
    if (r === undefined) return null;
    this.rows.delete(id);
    return r.expiresAtMs > nowMs ? r : null;
  }
  async peek(id: string, nowMs: number): Promise<PasskeyChallengeRecord | null> {
    const r = this.rows.get(id);
    return r !== undefined && r.expiresAtMs > nowMs ? r : null;
  }
}

export class InMemoryPasskeyCredentialRepository implements PasskeyCredentialRepository {
  private readonly rows = new Map<string, StoredPasskey>();
  async insert(passkey: StoredPasskey): Promise<boolean> {
    if (this.rows.has(passkey.credentialId)) return false;
    this.rows.set(passkey.credentialId, passkey);
    return true;
  }
  async find(credentialId: string): Promise<StoredPasskey | null> {
    return this.rows.get(credentialId) ?? null;
  }
  async update(passkey: StoredPasskey): Promise<void> {
    this.rows.set(passkey.credentialId, passkey);
  }
}

export class InMemoryAuthEventPublisher implements AuthEventPublisher {
  readonly events: AuthEvent[] = [];
  async publish(event: AuthEvent): Promise<void> {
    this.events.push(event);
  }
}

/**
 * Fake WebAuthn verifier. The "response" is a plain JSON object a test builds:
 *   register: { challenge, credentialId, publicKey, signCount, origin }
 *   assert:   { challenge, credentialId, signCount, origin, userHandle }
 * It checks the challenge, the origin and the signature counter claim but performs NO
 * cryptography. A real adapter (CBOR/COSE, RP ID hash, signature) replaces it; until then
 * production boot refuses to start because no production adapter set exists.
 */
export class DevPasskeyVerifier implements PasskeyVerifier {
  constructor(private readonly expectedOrigin: string) {}

  private parse(response: unknown): Record<string, unknown> | null {
    return typeof response === "object" && response !== null ? (response as Record<string, unknown>) : null;
  }

  async verifyRegistration(input: { challenge: string; response: unknown }): Promise<PasskeyResult<PasskeyCredential>> {
    const r = this.parse(input.response);
    if (r === null) return { ok: false, reason: "invalid_response" };
    if (r["challenge"] !== input.challenge) return { ok: false, reason: "challenge_mismatch" };
    if (r["origin"] !== this.expectedOrigin) return { ok: false, reason: "origin_mismatch" };
    const { credentialId, publicKey, signCount } = r;
    if (typeof credentialId !== "string" || typeof publicKey !== "string" || typeof signCount !== "number") {
      return { ok: false, reason: "invalid_response" };
    }
    return { ok: true, value: { credentialId, publicKey, signCount } };
  }

  async verifyAssertion(input: {
    challenge: string;
    response: unknown;
    credential: PasskeyCredential;
  }): Promise<PasskeyResult<{ credentialId: string; newSignCount: number; userHandle: string }>> {
    const r = this.parse(input.response);
    if (r === null) return { ok: false, reason: "invalid_response" };
    if (r["challenge"] !== input.challenge) return { ok: false, reason: "challenge_mismatch" };
    if (r["origin"] !== this.expectedOrigin) return { ok: false, reason: "origin_mismatch" };
    if (r["credentialId"] !== input.credential.credentialId) return { ok: false, reason: "unknown_credential" };
    const { signCount, userHandle } = r;
    if (typeof signCount !== "number" || typeof userHandle !== "string") return { ok: false, reason: "invalid_response" };
    return { ok: true, value: { credentialId: input.credential.credentialId, newSignCount: signCount, userHandle } };
  }
}

/**
 * Fail-closed production default: no admin grant source is composed yet, so no web session can be
 * opened (403 web_sign_in_not_allowed) until composition supplies a real reader.
 */
export class UnconfiguredAdminGrantReader implements AdminGrantReader {
  async hasStandingAdminGrant(): Promise<boolean> {
    return false;
  }
}

/** DEVELOPMENT AND TEST fixture: grants are added by test code. Per process. */
export class InMemoryAdminGrantReader implements AdminGrantReader {
  private readonly grants = new Map<string, number | null>();
  grant(userId: string, expiresAtMs: number | null = null): void {
    this.grants.set(userId, expiresAtMs);
  }
  revoke(userId: string): void {
    this.grants.delete(userId);
  }
  async hasStandingAdminGrant(userId: string, nowMs: number): Promise<boolean> {
    const exp = this.grants.get(userId);
    return exp !== undefined && (exp === null || exp > nowMs);
  }
}
