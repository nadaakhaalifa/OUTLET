import type { AccessClaims } from "@outlet/auth-core";
import type { SELLER_ROLES } from "@outlet/policy";
import { decodeJwt } from "jose";
import type { AuthenticatedUser } from "./http.js";
import { Problems } from "./problem.js";

export type SellerRole = (typeof SELLER_ROLES)[number];

/** Verifies an access JWT for one market (DB market id). Throws a 401 Problem when rejected. */
export interface AccessTokenVerifier {
  verify(jwt: string, marketId: string, now: Date): Promise<AuthenticatedUser>;
}

/** Store membership of a user (ERD `store_members`). Only active memberships count. */
export interface StoreMembershipPort {
  find(marketId: string, userId: string, storeId: string): Promise<{ readonly roles: readonly SellerRole[] } | null>;
}

/** What @outlet/auth-core SessionService offers; one per market (its audience is `outlet:{market}`). */
export interface MarketTokenService {
  readonly audience: string;
  verifyAccessToken(jwt: string, now?: Date): Promise<AccessClaims>;
}

/**
 * ES256 verification through @outlet/auth-core (algorithm allow-list, pinned kid, issuer, audience, exp).
 * A token valid for another market is reported as `market-mismatch` (contract: Market parameter); the claim used for
 * that message is read only after verification failed and never grants anything.
 */
export class SessionTokenVerifier implements AccessTokenVerifier {
  constructor(private readonly byMarket: ReadonlyMap<string, MarketTokenService>) {}

  async verify(jwt: string, marketId: string, now: Date): Promise<AuthenticatedUser> {
    const svc = this.byMarket.get(marketId);
    if (svc === undefined) throw Problems.unauthenticated("invalid-token");
    try {
      const c = await svc.verifyAccessToken(jwt, now);
      return { userId: c.userId, sessionId: c.sessionId, amr: c.amr };
    } catch {
      throw Problems.unauthenticated(this.otherMarketAudience(jwt, svc.audience) ? "market-mismatch" : "invalid-token");
    }
  }

  private otherMarketAudience(jwt: string, expected: string): boolean {
    try {
      const aud = decodeJwt(jwt).aud;
      const auds = typeof aud === "string" ? [aud] : (aud ?? []);
      const known = new Set([...this.byMarket.values()].map((s) => s.audience));
      return auds.some((a) => a !== expected && known.has(a));
    } catch {
      return false;
    }
  }
}

/** Test and pre-migration adapter. */
export class InMemoryStoreMemberships implements StoreMembershipPort {
  private readonly rows = new Map<string, readonly SellerRole[]>();
  private k = (marketId: string, userId: string, storeId: string): string => `${marketId}|${userId}|${storeId}`;

  grant(marketId: string, userId: string, storeId: string, roles: readonly SellerRole[]): void {
    this.rows.set(this.k(marketId, userId, storeId), [...roles]);
  }

  find(marketId: string, userId: string, storeId: string): Promise<{ readonly roles: readonly SellerRole[] } | null> {
    const roles = this.rows.get(this.k(marketId, userId, storeId));
    return Promise.resolve(roles === undefined || roles.length === 0 ? null : { roles });
  }
}

/**
 * Production default until the `store_members` migration and its Pg adapter exist: nobody is a member, so every
 * seller route answers 404. Fail closed, never open.
 */
export class UnconfiguredStoreMemberships implements StoreMembershipPort {
  find(): Promise<null> {
    return Promise.resolve(null);
  }
}
