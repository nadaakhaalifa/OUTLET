import { SetMetadata } from "@nestjs/common";
import type { Audience } from "@outlet/auth-core";
import type { Action, ResourceType } from "@outlet/policy";

export const AUTHZ_META = "outlet:authz";
export const IDEMPOTENT_META = "outlet:idempotent";
export const RATE_LIMIT_META = "outlet:rate-limit";

export type AuthzMeta =
  | { readonly kind: "public" }
  /**
   * Authenticated and operating only on the caller's own data. The route takes no object id,
   * so there is nothing to confuse (no BOLA surface); the data is keyed by the token subject.
   */
  | { readonly kind: "self"; readonly audience: Audience }
  /** Authorised through `decide()` against a loaded resource. */
  | {
      readonly kind: "resource";
      readonly audience: Audience;
      readonly action: Action;
      readonly resourceType: ResourceType;
      /** DI token of a ResourceResolver. */
      readonly resolver: symbol;
      readonly idParam: string;
    };

/** Explicitly unauthenticated route. Every route must declare this or an authorization mode. */
export const Public = () => SetMetadata(AUTHZ_META, { kind: "public" } satisfies AuthzMeta);

export const AuthenticatedSelf = (audience: Audience = "buyer_api") =>
  SetMetadata(AUTHZ_META, { kind: "self", audience } satisfies AuthzMeta);

export const Authorize = (opts: Omit<Extract<AuthzMeta, { kind: "resource" }>, "kind" | "audience"> & { audience?: Audience }) =>
  SetMetadata(AUTHZ_META, {
    kind: "resource",
    audience: opts.audience ?? "buyer_api",
    action: opts.action,
    resourceType: opts.resourceType,
    resolver: opts.resolver,
    idParam: opts.idParam,
  } satisfies AuthzMeta);

export interface IdempotentOptions {
  /** True for money, stock and order writes: a missing key is a 400. */
  readonly required: boolean;
}
export const Idempotent = (options: IdempotentOptions) => SetMetadata(IDEMPOTENT_META, options);

export type RateLimitDimension = "ip" | "user" | "device" | "phone" | "challenge";

export interface RateLimitSpec {
  readonly dimension: RateLimitDimension;
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitMeta {
  readonly rules: readonly RateLimitSpec[];
  /** What to do when the limiter itself fails. Security sensitive routes fail closed. */
  readonly onLimiterError: "closed" | "open";
}

export const RateLimit = (rules: readonly RateLimitSpec[], onLimiterError: "closed" | "open" = "closed") =>
  SetMetadata(RATE_LIMIT_META, { rules, onLimiterError } satisfies RateLimitMeta);

/** Opt a route out of the default limit (health probes). */
export const SkipRateLimit = () => RateLimit([]);
