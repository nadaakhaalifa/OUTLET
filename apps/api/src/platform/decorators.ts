import { SetMetadata } from "@nestjs/common";
import type { KillSwitchName } from "@outlet/flags";
import type { Action, Resource } from "@outlet/policy";
import type { z } from "zod";
import type { ApiRequest } from "./http.js";
import type { RateBudget, RateKey } from "./rate-limit/budgets.js";

export const META = {
  contract: "outlex:contract",
  authz: "outlex:authz",
  reasonCode: "outlex:reason-code",
  paginated: "outlex:paginated",
  rateLimit: "outlex:rate-limit",
  noIdempotency: "outlex:no-idempotency",
  killSwitch: "outlex:kill-switch",
  deprecated: "outlex:deprecated",
} as const;

/** Zod schemas of one operation: drive validation, the response allow-list and the generated OpenAPI. */
export interface ContractDef {
  readonly operationId: string;
  readonly summary: string;
  readonly tags?: readonly string[];
  /** Path parameters other than `market`. */
  readonly params?: z.ZodObject;
  readonly query?: z.ZodObject;
  readonly body?: z.ZodType;
  /** Explicit serializer: the handler result is parsed through it (unknown fields are dropped or rejected). */
  readonly response: z.ZodType;
  readonly status?: number;
  /** Public routes only; authenticated responses are always `private, no-store`. */
  readonly cacheControl?: string;
  /** Upper bound on app-pool statements per request (BUILD-PROMPT §2 query-count assertion). */
  readonly maxQueries: number;
  /**
   * The response carries credentials (access/refresh tokens). The idempotency interceptor then persists NO body (only the status,
   * marked redacted) and a same-key replay answers 409 `idempotent-replay-unavailable`: fail closed, no token is ever stored.
   */
  readonly sensitiveResponse?: boolean;
}

export interface ResolveContext {
  readonly req: ApiRequest;
  readonly marketId: string;
  readonly userId: string;
  /** Present on store-tenant routes once membership is proven. */
  readonly storeId: string | undefined;
}

/** Loads (or builds) the policy resource for a request. `null` means "not found or not visible" (404). */
export type ResourceResolver = (c: ResolveContext) => Resource | null | Promise<Resource | null>;

export type AuthzMeta =
  | { readonly kind: "public" }
  | { readonly kind: "authorize"; readonly action: Action; readonly resolver: ResourceResolver; readonly tenant: "user" | "store" };

export type RateLimitMeta = { readonly exempt: string } | { readonly budget: RateBudget; readonly keys: readonly RateKey[] };

export interface DeprecationMeta {
  readonly deprecatedAt: Date;
  readonly sunset: Date;
  readonly link?: string;
}

export const Contract = (c: ContractDef): MethodDecorator => SetMetadata(META.contract, c);

/** Explicitly unauthenticated. Credentials sent to a public route are ignored. */
export const Public = (): MethodDecorator => SetMetadata(META.authz, { kind: "public" } satisfies AuthzMeta);

/**
 * Authenticated route decided by @outlet/policy `authorize(principal, action, resource)`.
 * tenant "store": the caller acts for the store in `X-Store-Id` (membership, passkey and role checked; RLS store context).
 */
export const Authorize = (action: Action, resolver: ResourceResolver, opts: { tenant?: "user" | "store" } = {}): MethodDecorator =>
  SetMetadata(META.authz, { kind: "authorize", action, resolver, tenant: opts.tenant ?? "user" } satisfies AuthzMeta);

/** The caller must send `X-Reason-Code` (required for REQUIRES_REASON_CODE actions). */
export const ReasonCode = (): MethodDecorator => SetMetadata(META.reasonCode, true);

/** Keyset-paginated list: query has `cursor` + `limit` (≤ 50) and the response is `{ items, next_cursor }`. */
export const Paginated = (): MethodDecorator => SetMetadata(META.paginated, true);

export const RateLimit = (spec: { budget: RateBudget; keys?: readonly RateKey[] }): MethodDecorator =>
  SetMetadata(META.rateLimit, { budget: spec.budget, keys: spec.keys ?? spec.budget.keys } satisfies RateLimitMeta);

/** Only for infrastructure probes; the reason is recorded in the route audit and the OpenAPI document. */
export const NoRateLimit = (reason: string): MethodDecorator => SetMetadata(META.rateLimit, { exempt: reason } satisfies RateLimitMeta);

/** Opt out of the Idempotency-Key requirement: pure POSTs only (quotes, parsing) with no side effects. */
export const NoIdempotency = (reason: string): MethodDecorator => SetMetadata(META.noIdempotency, reason);

/** 503 `feature-disabled` while the kill switch is off. */
export const KillSwitch = (name: KillSwitchName): MethodDecorator => SetMetadata(META.killSwitch, name);

/** Adds `Deprecation`, `Sunset` and `Link` headers; the audit requires sunset ≥ deprecation + 183 days. */
export const Deprecated = (d: DeprecationMeta): MethodDecorator => SetMetadata(META.deprecated, d);
