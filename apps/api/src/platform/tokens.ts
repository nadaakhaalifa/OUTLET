/** DI tokens for platform ports. Symbols so that no string collision can swap an implementation. */
export const APP_CONFIG = Symbol("APP_CONFIG");
export const CLOCK = Symbol("CLOCK");
export const CSPRNG = Symbol("CSPRNG");
export const ID_GENERATOR = Symbol("ID_GENERATOR");
export const IDEMPOTENCY_SERVICE = Symbol("IDEMPOTENCY_SERVICE");
export const RATE_LIMITER = Symbol("RATE_LIMITER");
export const POLICY_RULES = Symbol("POLICY_RULES");
export const AUTHENTICATOR = Symbol("AUTHENTICATOR");
export const AUDIT_SINK = Symbol("AUDIT_SINK");
