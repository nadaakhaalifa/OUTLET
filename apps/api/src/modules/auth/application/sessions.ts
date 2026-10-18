import {
  constantTimeEqual,
  hashRefreshToken,
  sha256Hex,
  revokeFamily,
  revokeSession,
  rotateRefreshToken,
  touchSession,
  type Csprng,
} from "@outlet/auth-core";
import type { AuthEvent, AuthEventPublisher, SessionRepository, StoredSession, User, UserDirectory } from "../domain/ports";
import type { Clock } from "./common";
import type { SessionIssuer } from "./session-issuer";

export class GetSession {
  constructor(private readonly sessions: SessionRepository) {}

  async execute(sessionId: string): Promise<StoredSession | null> {
    const s = await this.sessions.find(sessionId);
    return s !== null && s.session.revokedAtMs === null ? s : null;
  }
}

export class ListSessions {
  constructor(private readonly sessions: SessionRepository) {}

  /** Only the caller's own, still active sessions; newest first. */
  async execute(userId: string): Promise<readonly StoredSession[]> {
    const all = await this.sessions.listByUser(userId);
    return all
      .filter((s) => s.session.userId === userId && s.session.revokedAtMs === null)
      .sort((a, b) => b.session.createdAtMs - a.session.createdAtMs);
  }
}

/** Revokes the session and its refresh family so the refresh token dies with the access session. */
export class RevokeSession {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly clock: Clock,
    private readonly events: AuthEventPublisher,
  ) {}

  async execute(sessionId: string, reason: "logout" | "user_revoked" = "user_revoked"): Promise<boolean> {
    const s = await this.sessions.find(sessionId);
    if (s === null || s.session.revokedAtMs !== null) return false;
    const nowMs = this.clock.nowMs();
    await this.sessions.save({
      ...s,
      session: revokeSession(s.session, nowMs),
      family: revokeFamily(s.family, nowMs, "logout"),
    });
    await this.events.publish({
      type: "session.revoked",
      sessionId: s.session.id,
      userId: s.session.userId,
      familyId: s.family.familyId,
      reason,
      notifyUser: false,
      occurredAtMs: nowMs,
    });
    return true;
  }
}

export interface RefreshDeps {
  readonly sessions: SessionRepository;
  readonly users: UserDirectory;
  readonly issuer: SessionIssuer;
  readonly events: AuthEventPublisher;
  readonly clock: Clock;
  readonly rng: Csprng;
  readonly newId: () => string;
}

export type RefreshResult =
  | {
      readonly kind: "ok";
      readonly sessionId: string;
      readonly user: User;
      readonly accessToken: string;
      readonly accessExpiresAtMs: number;
      readonly refreshToken: string;
      readonly refreshExpiresAtMs: number;
    }
  /** Unknown, expired, revoked, reused and wrong-device tokens are indistinguishable to the caller. */
  | { readonly kind: "invalid" }
  /** A concurrent rotation won; the client must keep only the token it received from the winner. */
  | { readonly kind: "conflict" };

/**
 * Rotating, device-bound refresh (spec 1). The presented token is looked up by its hash; a token
 * that was already rotated, or presented by another install, revokes the whole family and emits
 * `session.revoked` with `notifyUser`.
 */
export class RefreshSession {
  constructor(private readonly deps: RefreshDeps) {}

  /**
   * `installId` is the client's install id for mobile sessions. For a web session it is ignored:
   * the binding is the server-minted install token (`X-Admin-Install`, `adminInstallToken`), whose
   * SHA-256 must equal the hash on the session's device row. A missing, wrong or revoked token
   * is a device mismatch: the family is revoked and the caller gets the same 401 as any bad token.
   */
  async execute(input: { refreshToken: string; installId: string | null; adminInstallToken?: string | null }): Promise<RefreshResult> {
    const d = this.deps;
    const stored = await d.sessions.findByRefreshHash(hashRefreshToken(input.refreshToken));
    if (stored === null || stored.session.revokedAtMs !== null) return { kind: "invalid" };

    let presentingDeviceId: string;
    if (stored.platform === "web") {
      const token = input.adminInstallToken ?? null;
      const expected = stored.installSecretHash ?? null;
      const matches = token !== null && expected !== null && constantTimeEqual(sha256Hex(token), expected);
      // A value that cannot equal any device id turns the mismatch into the standard revoke path.
      presentingDeviceId = matches ? stored.family.deviceId : `mismatch:${stored.family.deviceId}`;
    } else {
      if (input.installId === null) return { kind: "invalid" };
      presentingDeviceId = input.installId;
    }

    const nowMs = d.clock.nowMs();
    const result = rotateRefreshToken({
      family: stored.family,
      presentedToken: input.refreshToken,
      presentingDeviceId,
      newRecordId: d.newId(),
      rng: d.rng,
      nowMs,
    });

    if (result.outcome === "reuse_detected" || result.outcome === "device_mismatch") {
      const next: StoredSession = {
        ...stored,
        session: revokeSession(stored.session, nowMs),
        family: result.family,
      };
      const saved = await d.sessions.compareAndSave(stored, next);
      if (saved) {
        const event: AuthEvent = {
          type: "session.revoked",
          sessionId: stored.session.id,
          userId: stored.session.userId,
          familyId: stored.family.familyId,
          reason: result.outcome,
          notifyUser: true,
          occurredAtMs: nowMs,
        };
        await d.events.publish(event);
      }
      return { kind: "invalid" };
    }
    if (result.outcome !== "rotated") return { kind: "invalid" };

    const next: StoredSession = {
      ...stored,
      session: touchSession(stored.session, nowMs),
      family: result.family,
    };
    if (!(await d.sessions.compareAndSave(stored, next))) return { kind: "conflict" };

    const user = await d.users.findById(stored.session.userId);
    if (user === null) return { kind: "invalid" };
    const access = await d.issuer.accessFor({
      userId: stored.session.userId,
      sessionId: stored.session.id,
      amr: stored.session.amr,
      ...(stored.platform === "web" ? { audience: "admin_api" as const } : {}),
    });
    const active = result.family.records.find((r) => r.status === "active");
    return {
      kind: "ok",
      sessionId: stored.session.id,
      user,
      ...access,
      refreshToken: result.token,
      refreshExpiresAtMs: active?.expiresAtMs ?? nowMs,
    };
  }
}

/** Profile summary for the signed-in user: no P3, no phone, no e-mail. */
export class GetMe {
  constructor(private readonly users: UserDirectory) {}

  async execute(userId: string): Promise<User | null> {
    return this.users.findById(userId);
  }
}
