import { buildAccessClaims, issueFamily, type Amr, type Csprng } from "@outlet/auth-core";
import type { AccessTokenIssuer, SessionRepository, User } from "../domain/ports";
import type { Clock } from "./common";

export interface SessionIssuerDeps {
  readonly sessions: SessionRepository;
  readonly tokens: AccessTokenIssuer;
  readonly clock: Clock;
  readonly rng: Csprng;
  readonly newId: () => string;
  readonly issuer: string;
}

export interface IssuedSession {
  readonly sessionId: string;
  readonly accessToken: string;
  readonly accessExpiresAtMs: number;
  readonly refreshToken: string;
  readonly refreshExpiresAtMs: number;
}

/** Creates a session, its refresh family and the first access token. Shared by every login method. */
export class SessionIssuer {
  constructor(private readonly deps: SessionIssuerDeps) {}

  async open(input: {
    readonly user: User;
    readonly installId: string;
    readonly platform: "ios" | "android";
    readonly amr: readonly Amr[];
  }): Promise<IssuedSession> {
    const d = this.deps;
    const nowMs = d.clock.nowMs();
    const sessionId = d.newId();
    const { family, token: refreshToken } = issueFamily({
      familyId: d.newId(),
      userId: input.user.id,
      deviceId: input.installId,
      recordId: d.newId(),
      rng: d.rng,
      nowMs,
    });
    const claims = buildAccessClaims({
      issuer: d.issuer,
      userId: input.user.id,
      audience: "buyer_api",
      sessionId,
      jti: d.newId(),
      amr: input.amr,
      nowMs,
    });
    await d.sessions.insert({
      session: {
        id: sessionId,
        userId: input.user.id,
        deviceId: input.installId,
        familyId: family.familyId,
        amr: claims.amr,
        createdAtMs: nowMs,
        lastUsedAtMs: nowMs,
        revokedAtMs: null,
      },
      family,
      platform: input.platform,
    });
    return {
      sessionId,
      accessToken: await d.tokens.issue(claims),
      accessExpiresAtMs: claims.exp * 1000,
      refreshToken,
      refreshExpiresAtMs: family.records[0]?.expiresAtMs ?? nowMs,
    };
  }

  /** New access token for an existing session (after a refresh rotation). */
  async accessFor(input: {
    readonly userId: string;
    readonly sessionId: string;
    readonly amr: readonly Amr[];
  }): Promise<{ accessToken: string; accessExpiresAtMs: number }> {
    const d = this.deps;
    const claims = buildAccessClaims({
      issuer: d.issuer,
      userId: input.userId,
      audience: "buyer_api",
      sessionId: input.sessionId,
      jti: d.newId(),
      amr: input.amr,
      nowMs: d.clock.nowMs(),
    });
    return { accessToken: await d.tokens.issue(claims), accessExpiresAtMs: claims.exp * 1000 };
  }
}
