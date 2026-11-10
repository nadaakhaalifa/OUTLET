import type { StoreContext, UserContext } from "@outlet/db";
import type { Logger } from "@outlet/logger";
import type { Market } from "@outlet/markets-config";
import type { Principal } from "@outlet/policy";
import type { FastifyReply, FastifyRequest } from "fastify";

/** A verified access token (ES256, 10 min). No personal data beyond the subject id. */
export interface AuthenticatedUser {
  readonly userId: string;
  readonly sessionId: string;
  readonly amr: readonly string[];
}

/** Per-request state set by the onRequest hook and the guards. Never contains personal data. */
export interface RequestState {
  readonly requestId: string;
  readonly startedAt: number;
  /** Market from the path (`/v1/{market}/...`) or, on global routes, a valid `X-Market` header. */
  market: Market | undefined;
  /** markets.id upper-cased: the value stored in `market_id` columns (contract conflict C3). */
  marketId: string | undefined;
  log: Logger;
  /** Set by AccessTokenGuard on non-public routes. */
  user: AuthenticatedUser | undefined;
  /** Set by PolicyGuard: the principal the policy decision used (seller principals are scoped to one store). */
  principal: Principal | undefined;
  /** Active store (X-Store-Id) after membership was proven. */
  storeId: string | undefined;
  /** Database context every transaction of this request binds with SET LOCAL (ADR-0011). */
  db: UserContext | StoreContext | undefined;
  reasonCode: string | undefined;
  /** Exact request bytes, kept only for webhook routes (signature verification runs over the raw body, before any parsing). */
  rawBody: Uint8Array | undefined;
}

declare module "fastify" {
  interface FastifyRequest {
    ctx: RequestState;
  }
}

export type ApiRequest = FastifyRequest;
export type ApiReply = FastifyReply;

export const MUTATING_METHODS: readonly string[] = ["POST", "PUT", "PATCH", "DELETE"];

/** First value of a header (lower-case name). */
export const headerValue = (req: Pick<FastifyRequest, "headers">, name: string): string | undefined => {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
