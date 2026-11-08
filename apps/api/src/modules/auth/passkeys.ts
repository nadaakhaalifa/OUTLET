import { randomBytes } from "node:crypto";
import { uuidv7 } from "@outlet/ids";
import type { PasskeyAssertionDto, PasskeyVerifier } from "@outlet/auth-core";
import type { StrongAuthMethod, StrongAuthPort } from "@outlet/seller-accounts";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { Problems } from "../../platform/problem.js";

/** A registered WebAuthn credential. `publicKey` is the COSE key; `credentialId` is base64url. Never sent to clients. */
export interface PasskeyCredentialRecord {
  readonly id: string;
  readonly marketId: string;
  readonly userId: string;
  readonly credentialId: string;
  readonly publicKey: Uint8Array;
  readonly counter: number;
  readonly transports: readonly string[];
  readonly backupEligible: boolean;
  readonly aaguid: string | null;
  /** WebAuthn user.id: random per user, base64url (never the user UUID). */
  readonly userHandle: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
}

/** Persistence of credentials (table `passkey_credentials`, not migrated yet: production wiring is Unconfigured and fails closed). */
export interface PasskeyStore {
  listByUser(marketId: string, userId: string): Promise<readonly PasskeyCredentialRecord[]>;
  findByCredentialId(marketId: string, credentialId: string): Promise<PasskeyCredentialRecord | null>;
  insert(record: PasskeyCredentialRecord): Promise<void>;
  /** Persists the new signature counter. Must reject (throw) a counter that does not strictly increase (0 -> 0 is allowed for authenticators that never count). */
  recordUse(cred: PasskeyCredentialRecord, counter: number, now: Date): Promise<void>;
  /** Owner-scoped revocation; false when the credential is not the user's (or already revoked). */
  revoke(marketId: string, userId: string, id: string, now: Date): Promise<boolean>;
}

export type ChallengePurpose = "register" | "assert";
export interface StoredChallenge {
  readonly id: string;
  readonly marketId: string;
  readonly purpose: ChallengePurpose;
  /** Registration: the enrolling user. Assertion: null (discoverable credential, the user is found by the credential). */
  readonly userId: string | null;
  readonly deviceId: string;
  readonly challenge: string;
  /** Registration only: the WebAuthn user handle the options carried. */
  readonly userHandle?: string | null;
  readonly expiresAt: Date;
}

/** One-shot challenges: `take` returns the challenge once and deletes it (replay of a ceremony fails). */
export interface ChallengeStore {
  put(c: StoredChallenge): Promise<void>;
  take(id: string, marketId: string, now: Date): Promise<StoredChallenge | null>;
}

export interface CeremonyOptions {
  readonly challengeId: string;
  readonly publicKey: Record<string, unknown>;
  readonly expiresAt: Date;
}

/** What the HTTP routes need. The assertion half is exactly @outlet/auth-core's PasskeyVerifier. */
export interface PasskeyPort extends PasskeyVerifier {
  registrationOptions(input: { userId: string; deviceId: string; now: Date }): Promise<CeremonyOptions>;
  verifyRegistration(input: { userId: string; deviceId: string; challengeId: string; credential: RegistrationResponseJSON; now: Date }): Promise<PasskeyCredentialRecord>;
  assertionOptions(input: { deviceId: string; now: Date }): Promise<CeremonyOptions>;
  /** True when the user holds at least one registered credential (the strong-auth gate for seller and admin accounts). */
  hasCredential(userId: string): Promise<boolean>;
  verifyAssertion(dto: PasskeyAssertionDto & { deviceId: string }): Promise<{ userId: string; credentialId: string }>;
  list(userId: string): Promise<readonly PasskeyCredentialRecord[]>;
  revoke(userId: string, id: string, now: Date): Promise<boolean>;
}

export interface PasskeyConfig {
  readonly marketId: string;
  readonly rpName: string;
  readonly rpId: string;
  /** Exact origins allowed to run ceremonies (web BFF origin). */
  readonly origins: readonly string[];
  readonly challengeTtlMs: number;
  /** WebAuthn userName shown by the authenticator: a masked phone, never the user id. Default: a generic label. */
  readonly userLabel?: (userId: string) => Promise<string>;
  readonly now: () => Date;
}

const newUserHandle = (): string => randomBytes(32).toString("base64url");

/**
 * WebAuthn ceremonies with @simplewebauthn/server (ES256/EdDSA/RS256, attestation "none", user verification required,
 * discoverable credentials). Challenges are single-use and expire; the signature counter is checked by the library and
 * persisted after every assertion; origin and RP id are pinned to configuration, never taken from the request.
 */
export class WebAuthnPasskeys implements PasskeyPort {
  constructor(
    private readonly cfg: PasskeyConfig,
    private readonly store: PasskeyStore,
    private readonly challenges: ChallengeStore,
  ) {}

  async registrationOptions(input: { userId: string; deviceId: string; now: Date }): Promise<CeremonyOptions> {
    const existing = await this.store.listByUser(this.cfg.marketId, input.userId);
    // One handle per user: a second credential must not overwrite the first resident credential on the authenticator.
    const userHandle = existing[0]?.userHandle ?? newUserHandle();
    const options = await generateRegistrationOptions({
      rpName: this.cfg.rpName,
      rpID: this.cfg.rpId,
      userName: await this.label(input.userId),
      userID: Uint8Array.from(Buffer.from(userHandle, "base64url")),
      attestationType: "none",
      excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: [...c.transports] })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    return this.issue("register", input.userId, input.deviceId, options.challenge, options as unknown as Record<string, unknown>, input.now, userHandle);
  }

  private async label(userId: string): Promise<string> {
    try {
      return (await this.cfg.userLabel?.(userId)) ?? "Outlex account";
    } catch {
      return "Outlex account";
    }
  }

  async verifyRegistration(input: { userId: string; deviceId: string; challengeId: string; credential: RegistrationResponseJSON; now: Date }): Promise<PasskeyCredentialRecord> {
    const ch = await this.challenges.take(input.challengeId, this.cfg.marketId, input.now);
    if (ch?.purpose !== "register" || ch.userId !== input.userId || ch.deviceId !== input.deviceId || ch.userHandle == null) throw Problems.unprocessable("passkey-challenge-invalid");
    let verified;
    try {
      verified = await verifyRegistrationResponse({
        response: input.credential,
        expectedChallenge: ch.challenge,
        expectedOrigin: [...this.cfg.origins],
        expectedRPID: this.cfg.rpId,
        requireUserVerification: true,
      });
    } catch {
      throw Problems.unprocessable("passkey-verification-failed");
    }
    if (!verified.verified) throw Problems.unprocessable("passkey-verification-failed");
    const info = verified.registrationInfo;
    const taken = await this.store.findByCredentialId(this.cfg.marketId, info.credential.id);
    if (taken !== null) throw Problems.conflict("passkey-already-registered");
    const record: PasskeyCredentialRecord = {
      id: uuidv7(input.now.getTime()),
      marketId: this.cfg.marketId,
      userId: input.userId,
      credentialId: info.credential.id,
      publicKey: info.credential.publicKey,
      counter: info.credential.counter,
      transports: info.credential.transports ?? [],
      backupEligible: info.credentialDeviceType === "multiDevice",
      userHandle: ch.userHandle,
      aaguid: /^[0-9a-f-]{36}$/.test(info.aaguid) && info.aaguid !== "00000000-0000-0000-0000-000000000000" ? info.aaguid : null,
      createdAt: input.now,
      lastUsedAt: null,
    };
    await this.store.insert(record);
    return record;
  }

  async assertionOptions(input: { deviceId: string; now: Date }): Promise<CeremonyOptions> {
    const options = await generateAuthenticationOptions({ rpID: this.cfg.rpId, userVerification: "required", allowCredentials: [] });
    return this.issue("assert", null, input.deviceId, options.challenge, options as unknown as Record<string, unknown>, input.now);
  }

  /** @outlet/auth-core PasskeyVerifier: the DTO is the flattened assertion; `challengeId` names the stored challenge. */
  async verifyAssertion(dto: PasskeyAssertionDto & { deviceId: string }): Promise<{ userId: string; credentialId: string }> {
    const now = this.cfg.now();
    const ch = await this.challenges.take(dto.challengeId, this.cfg.marketId, now);
    if (ch?.purpose !== "assert" || ch.deviceId !== dto.deviceId) throw Problems.unprocessable("passkey-challenge-invalid");
    const cred = await this.store.findByCredentialId(this.cfg.marketId, dto.credentialId);
    // An unknown credential and a bad signature look the same from outside.
    if (cred === null) throw Problems.unauthenticated("passkey-rejected");
    const response: AuthenticationResponseJSON = {
      id: dto.credentialId,
      rawId: dto.credentialId,
      type: "public-key",
      response: { clientDataJSON: dto.clientDataJSON, authenticatorData: dto.authenticatorData, signature: dto.signature },
      clientExtensionResults: {},
    };
    let verified;
    try {
      verified = await verifyAuthenticationResponse({
        response,
        expectedChallenge: ch.challenge,
        expectedOrigin: [...this.cfg.origins],
        expectedRPID: this.cfg.rpId,
        credential: { id: cred.credentialId, publicKey: toBytes(cred.publicKey), counter: cred.counter, transports: cred.transports as never },
        requireUserVerification: true,
      });
    } catch {
      throw Problems.unauthenticated("passkey-rejected");
    }
    if (!verified.verified) throw Problems.unauthenticated("passkey-rejected");
    await this.store.recordUse(cred, verified.authenticationInfo.newCounter, now);
    return { userId: cred.userId, credentialId: cred.credentialId };
  }

  async hasCredential(userId: string): Promise<boolean> {
    return (await this.store.listByUser(this.cfg.marketId, userId)).length > 0;
  }

  list(userId: string): Promise<readonly PasskeyCredentialRecord[]> {
    return this.store.listByUser(this.cfg.marketId, userId);
  }

  revoke(userId: string, id: string, now: Date): Promise<boolean> {
    return this.store.revoke(this.cfg.marketId, userId, id, now);
  }

  private async issue(purpose: ChallengePurpose, userId: string | null, deviceId: string, challenge: string, publicKey: Record<string, unknown>, now: Date, userHandle: string | null = null): Promise<CeremonyOptions> {
    const id = uuidv7(now.getTime());
    const expiresAt = new Date(now.getTime() + this.cfg.challengeTtlMs);
    await this.challenges.put({ id, marketId: this.cfg.marketId, purpose, userId, deviceId, challenge, userHandle, expiresAt });
    return { challengeId: id, publicKey, expiresAt };
  }
}

const toBytes = (b: Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from(b);

/**
 * The strong-auth gate of @outlet/seller-accounts: a passkey enrolment counts only if THIS user holds a registered credential
 * whose id is the presented proof. TOTP is not built, so it never verifies (fail closed).
 */
export class PasskeyStrongAuth implements StrongAuthPort {
  constructor(private readonly store: PasskeyStore, private readonly marketId: string) {}

  async verifyEnrollment(input: { readonly userId: string; readonly method: StrongAuthMethod; readonly proof: string }): Promise<boolean> {
    if (input.method !== "passkey") return false;
    const found = await this.store.findByCredentialId(this.marketId, input.proof);
    return found !== null && found.userId === input.userId;
  }
}

/** Process-local stores: tests and local development only (production has no table yet, see UnconfiguredPasskeyStore). */
export class InMemoryPasskeyStore implements PasskeyStore {
  private readonly rows: PasskeyCredentialRecord[] = [];

  listByUser(marketId: string, userId: string): Promise<readonly PasskeyCredentialRecord[]> {
    return Promise.resolve(this.rows.filter((r) => r.marketId === marketId && r.userId === userId));
  }
  findByCredentialId(marketId: string, credentialId: string): Promise<PasskeyCredentialRecord | null> {
    return Promise.resolve(this.rows.find((r) => r.marketId === marketId && r.credentialId === credentialId) ?? null);
  }
  insert(record: PasskeyCredentialRecord): Promise<void> {
    this.rows.push(record);
    return Promise.resolve();
  }
  recordUse(cred: PasskeyCredentialRecord, counter: number, now: Date): Promise<void> {
    const i = this.rows.findIndex((r) => r.id === cred.id);
    const row = this.rows[i];
    if (row !== undefined) {
      if (!(counter > row.counter || (counter === 0 && row.counter === 0))) return Promise.reject(Problems.unauthenticated("passkey-rejected"));
      this.rows[i] = { ...row, counter, lastUsedAt: now };
    }
    return Promise.resolve();
  }
  revoke(marketId: string, userId: string, id: string): Promise<boolean> {
    const i = this.rows.findIndex((r) => r.id === id && r.marketId === marketId && r.userId === userId);
    if (i < 0) return Promise.resolve(false);
    this.rows.splice(i, 1);
    return Promise.resolve(true);
  }
}

export class InMemoryChallengeStore implements ChallengeStore {
  private readonly rows = new Map<string, StoredChallenge>();

  put(c: StoredChallenge): Promise<void> {
    this.rows.set(c.id, c);
    return Promise.resolve();
  }
  take(id: string, marketId: string, now: Date): Promise<StoredChallenge | null> {
    const c = this.rows.get(id);
    this.rows.delete(id);
    return Promise.resolve(c?.marketId !== marketId || c.expiresAt.getTime() <= now.getTime() ? null : c);
  }
}

/** Production default until relying party and auth pool are configured: every ceremony answers 503, nothing is stored. */
export class UnconfiguredPasskeys implements PasskeyPort {
  private fail(): never {
    throw Problems.unavailable("passkeys-unavailable");
  }
  registrationOptions(): Promise<CeremonyOptions> {
    return this.fail();
  }
  verifyRegistration(): Promise<PasskeyCredentialRecord> {
    return this.fail();
  }
  assertionOptions(): Promise<CeremonyOptions> {
    return this.fail();
  }
  verifyAssertion(): Promise<{ userId: string; credentialId: string }> {
    return this.fail();
  }
  hasCredential(): Promise<boolean> {
    return Promise.resolve(false);
  }
  list(): Promise<readonly PasskeyCredentialRecord[]> {
    return this.fail();
  }
  revoke(): Promise<boolean> {
    return this.fail();
  }
}
