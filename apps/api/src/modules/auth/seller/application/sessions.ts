import {
  SELLER_ENROL_TTL_MS,
  buildAccessClaims,
  hashRefreshToken,
  isRecentStrongFactor,
  issueFamily,
  revokeFamily,
  rotateRefreshToken,
  type Amr,
  type Csprng,
} from "@outlet/auth-core";
import type { AccessTokenIssuer } from "../../domain/ports";
import type { Clock } from "../../application/common";
import type {
  SellerAuthEvents,
  SellerMembershipRepository,
  SellerSessionRecord,
  SellerSessionRepository,
  SellerUserDirectory,
  StoredSellerSession,
} from "../domain/ports";

export interface SellerSessionDeps {
  readonly sessions: SellerSessionRepository;
  readonly memberships: SellerMembershipRepository;
  readonly users: SellerUserDirectory;
  readonly tokens: AccessTokenIssuer;
  readonly events: SellerAuthEvents;
  readonly clock: Clock;
  readonly rng: Csprng;
  readonly newId: () => string;
  readonly issuer: string;
}

export interface SellerMembershipView {
  readonly storeId: string;
  readonly role: string;
}

export interface IssuedSellerSession {
  readonly sessionId: string;
  readonly sellerUserId: string;
  readonly accessToken: string;
  readonly accessExpiresAtMs: number;
  readonly refreshToken: string;
  readonly refreshExpiresAtMs: number;
  readonly amr: readonly Amr[];
  readonly memberships: readonly SellerMembershipView[];
}

export interface IssuedEnrolToken {
  readonly sessionId: string;
  readonly accessToken: string;
  readonly expiresInSec: number;
}

/** Creates seller sessions: a 30 minute ENROL token (OTP only) or a FULL session (strong factor). */
export class SellerSessionIssuer {
  constructor(private readonly deps: SellerSessionDeps) {}

  async openEnrol(input: { sellerUserId: string; installId: string; amr: readonly Amr[]; restricted: boolean }): Promise<IssuedEnrolToken> {
    const d = this.deps;
    const nowMs = d.clock.nowMs();
    const sessionId = d.newId();
    const claims = buildAccessClaims({
      issuer: d.issuer,
      userId: input.sellerUserId,
      audience: "seller_api",
      sessionId,
      jti: d.newId(),
      amr: input.amr,
      nowMs,
      enrol: true,
    });
    await d.sessions.insert({
      session: {
        id: sessionId,
        sellerUserId: input.sellerUserId,
        kind: "enrol",
        restricted: input.restricted,
        installId: input.installId,
        amr: claims.amr,
        strongAtMs: null,
        createdAtMs: nowMs,
        lastUsedAtMs: nowMs,
        expiresAtMs: nowMs + SELLER_ENROL_TTL_MS,
        revokedAtMs: null,
      },
      family: null,
    });
    return { sessionId, accessToken: await d.tokens.issue(claims), expiresInSec: SELLER_ENROL_TTL_MS / 1000 };
  }

  /** `amr` must contain webauthn or totp: the caller has just verified a strong factor. */
  async openFull(input: { sellerUserId: string; installId: string; amr: readonly Amr[] }): Promise<IssuedSellerSession> {
    const d = this.deps;
    if (!input.amr.some((a) => a === "webauthn" || a === "totp")) throw new Error("a full seller session needs a strong factor");
    const nowMs = d.clock.nowMs();
    const sessionId = d.newId();
    const { family, token: refreshToken } = issueFamily({
      familyId: d.newId(),
      userId: input.sellerUserId,
      deviceId: input.installId,
      recordId: d.newId(),
      rng: d.rng,
      nowMs,
    });
    const claims = buildAccessClaims({
      issuer: d.issuer,
      userId: input.sellerUserId,
      audience: "seller_api",
      sessionId,
      jti: d.newId(),
      amr: input.amr,
      nowMs,
    });
    await d.sessions.insert({
      session: {
        id: sessionId,
        sellerUserId: input.sellerUserId,
        kind: "full",
        restricted: false,
        installId: input.installId,
        amr: claims.amr,
        strongAtMs: nowMs,
        createdAtMs: nowMs,
        lastUsedAtMs: nowMs,
        expiresAtMs: null,
        revokedAtMs: null,
      },
      family,
    });
    const memberships = (await d.memberships.listBySeller(input.sellerUserId)).map((m) => ({ storeId: m.storeId, role: m.role }));
    return {
      sessionId,
      sellerUserId: input.sellerUserId,
      accessToken: await d.tokens.issue(claims),
      accessExpiresAtMs: claims.exp * 1000,
      refreshToken,
      refreshExpiresAtMs: family.records[0]?.expiresAtMs ?? nowMs,
      amr: claims.amr,
      memberships,
    };
  }

  async accessFor(session: SellerSessionRecord): Promise<{ accessToken: string; accessExpiresAtMs: number }> {
    const d = this.deps;
    const claims = buildAccessClaims({
      issuer: d.issuer,
      userId: session.sellerUserId,
      audience: "seller_api",
      sessionId: session.id,
      jti: d.newId(),
      amr: session.amr,
      nowMs: d.clock.nowMs(),
    });
    return { accessToken: await d.tokens.issue(claims), accessExpiresAtMs: claims.exp * 1000 };
  }
}

export type SellerRefreshResult =
  | ({ readonly kind: "ok" } & IssuedSellerSession)
  | { readonly kind: "invalid" }
  | { readonly kind: "conflict" };

/** Rotating, device bound refresh with family reuse detection (same auth-core machinery as shoppers). */
export class SellerRefresh {
  constructor(
    private readonly deps: SellerSessionDeps,
    private readonly issuer: SellerSessionIssuer,
  ) {}

  async execute(input: { refreshToken: string; installId: string }): Promise<SellerRefreshResult> {
    const d = this.deps;
    const stored = await d.sessions.findByRefreshHash(hashRefreshToken(input.refreshToken));
    if (stored === null || stored.family === null || stored.session.revokedAtMs !== null) return { kind: "invalid" };
    const nowMs = d.clock.nowMs();
    const seller = await d.users.findById(stored.session.sellerUserId);
    if (seller === null || seller.status !== "active" || !seller.strongFactor) return { kind: "invalid" };

    const result = rotateRefreshToken({
      family: stored.family,
      presentedToken: input.refreshToken,
      presentingDeviceId: input.installId,
      newRecordId: d.newId(),
      rng: d.rng,
      nowMs,
    });
    if (result.outcome === "reuse_detected" || result.outcome === "device_mismatch") {
      const next: StoredSellerSession = {
        session: { ...stored.session, revokedAtMs: nowMs },
        family: result.family,
      };
      if (await d.sessions.compareAndSave(stored, next)) {
        await d.events.publish({
          type: "seller.session_revoked",
          sellerUserId: stored.session.sellerUserId,
          sessionId: stored.session.id,
          reason: result.outcome,
          notifySeller: true,
          occurredAtMs: nowMs,
        });
      }
      return { kind: "invalid" };
    }
    if (result.outcome !== "rotated") return { kind: "invalid" };

    const next: StoredSellerSession = {
      session: { ...stored.session, lastUsedAtMs: Math.max(stored.session.lastUsedAtMs, nowMs) },
      family: result.family,
    };
    if (!(await d.sessions.compareAndSave(stored, next))) return { kind: "conflict" };

    const access = await this.issuer.accessFor(stored.session);
    const memberships = (await d.memberships.listBySeller(stored.session.sellerUserId)).map((m) => ({ storeId: m.storeId, role: m.role }));
    const active = result.family.records.find((r) => r.status === "active");
    return {
      kind: "ok",
      sessionId: stored.session.id,
      sellerUserId: stored.session.sellerUserId,
      ...access,
      refreshToken: result.token,
      refreshExpiresAtMs: active?.expiresAtMs ?? nowMs,
      amr: stored.session.amr,
      memberships,
    };
  }
}

export class SellerSessions {
  constructor(private readonly deps: SellerSessionDeps) {}

  /** The caller's own active sessions, newest first. Never another seller's. */
  async list(sellerUserId: string): Promise<readonly StoredSellerSession[]> {
    const nowMs = this.deps.clock.nowMs();
    return (await this.deps.sessions.listBySeller(sellerUserId))
      .filter((s) => s.session.sellerUserId === sellerUserId && s.session.revokedAtMs === null && (s.session.expiresAtMs === null || s.session.expiresAtMs > nowMs))
      .sort((a, b) => b.session.createdAtMs - a.session.createdAtMs);
  }

  /** Revokes one of the caller's sessions. A foreign or unknown id is indistinguishable (false). */
  async revoke(sellerUserId: string, sessionId: string, reason: "logout" | "user_revoked"): Promise<boolean> {
    const s = await this.deps.sessions.find(sessionId);
    if (s === null || s.session.sellerUserId !== sellerUserId || s.session.revokedAtMs !== null) return false;
    const nowMs = this.deps.clock.nowMs();
    await this.deps.sessions.save({
      session: { ...s.session, revokedAtMs: nowMs },
      family: s.family === null ? null : revokeFamily(s.family, nowMs, "logout"),
    });
    await this.deps.events.publish({ type: "seller.session_revoked", sellerUserId, sessionId, reason, notifySeller: false, occurredAtMs: nowMs });
    return true;
  }

  /** Ends every session of a seller (clone suspicion, suspension). */
  async revokeAll(sellerUserId: string, reason: string, exceptSessionId?: string): Promise<number> {
    const nowMs = this.deps.clock.nowMs();
    let n = 0;
    for (const s of await this.deps.sessions.listBySeller(sellerUserId)) {
      if (s.session.revokedAtMs !== null || s.session.id === exceptSessionId) continue;
      await this.deps.sessions.save({
        session: { ...s.session, revokedAtMs: nowMs },
        family: s.family === null ? null : revokeFamily(s.family, nowMs, "admin"),
      });
      await this.deps.events.publish({ type: "seller.session_revoked", sellerUserId, sessionId: s.session.id, reason, notifySeller: true, occurredAtMs: nowMs });
      n++;
    }
    return n;
  }

  /**
   * Step-up gate for sensitive actions (payout bank change, role grants). True only for a FULL
   * session whose strong factor was asserted within `maxAgeSec`; an enrol token never qualifies.
   * To refresh the clock the seller signs in again with the passkey or TOTP.
   */
  async assertRecentStrongFactor(sessionId: string, maxAgeSec: number): Promise<boolean> {
    const s = await this.deps.sessions.find(sessionId);
    if (s === null || s.session.revokedAtMs !== null || s.session.kind !== "full") return false;
    return isRecentStrongFactor(s.session.strongAtMs, this.deps.clock.nowMs(), maxAgeSec);
  }
}
