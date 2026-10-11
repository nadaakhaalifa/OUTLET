/**
 * Mobile app -> API consumer expectations (spec A2.10).
 *
 * Each interaction states ONLY what the mobile port in `derivedFrom` consumes (Pact "be conservative
 * in what you require"): extra provider fields are fine, a missing or retyped one breaks the contract.
 * The mobile app has no HTTP client yet (ports are faked in-process), so the field sets below are the
 * wire shapes its ports/view-models will need. Money is a decimal-string piastre amount on the wire.
 */
import { eachLike, like, regex, type InteractionSpec } from "../pact-dsl";

export const CONSUMER = "outlet-mobile";
export const PROVIDER = "outlet-api";

export const UUID_RE = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const UUID = "0192f3a4-5b6c-7d8e-9f01-000000000001";
const MISSING = "0192f3a4-5b6c-7d8e-9f01-0000000000ff";
const IDEM = "0192f3a4-5b6c-7d8e-9f01-23456789abc9";
const TS = "2027-01-15T08:00:00.000Z";
const AUTH = { Authorization: "Bearer <access-token>", Accept: "application/json" } as const;
const JSON_CT = { "Content-Type": regex("application/json; charset=utf-8", "^application/json") };
const PROBLEM_CT = { "Content-Type": regex("application/problem+json; charset=utf-8", "^application/problem\\+json") };
const REQUEST_ID = { "X-Request-Id": like("01a3185c-5000-7dcb-92e4-dba5de6f1b34") };

const problem = (status: number, code: string, extra: Record<string, unknown> = {}) => ({
  type: regex(`/problems/${code}`, "^/problems/"),
  title: like("Problem"),
  status,
  code,
  request_id: like("01a3185c-5000-7dcb-92e4-dba5de6f1b34"),
  ...extra,
});

// next_cursor is null on the last page, so the mobile client only requires has_more.
const page = (items: unknown) => ({ items, page: { has_more: like(false) } });

export const MOBILE_INTERACTIONS: readonly InteractionSpec[] = [
  // ---- auth (apps/mobile onboarding; packages/validation phone) --------------------------------
  {
    description: "request an OTP for a valid Egyptian phone",
    providerState: "anonymous device with a passed age gate",
    openapi: "POST /v1/auth/otp/request",
    derivedFrom: "packages/validation phone.ts (E.164) + auth-core OtpChallenge",
    request: {
      method: "POST",
      path: "/v1/auth/otp/request",
      headers: { "Content-Type": "application/json", "X-App-Attest": "<attest>", "X-Client-Platform": "ios" },
      body: { phone_e164: "+201005550001" },
    },
    response: {
      status: 202,
      headers: { ...JSON_CT, ...REQUEST_ID },
      body: {
        challenge_id: regex(UUID, UUID_RE),
        expires_at: regex(TS, "^\\d{4}-\\d{2}-\\d{2}T"),
        resend_available_at: regex(TS, "^\\d{4}-\\d{2}-\\d{2}T"),
        attempts_remaining: like(5),
        channel: like("sms"),
      },
    },
  },
  {
    description: "OTP request with a malformed phone is a Problem+JSON 400 with pointers",
    providerState: "anonymous device with a passed age gate",
    openapi: "POST /v1/auth/otp/request",
    derivedFrom: "Problem+JSON handling shared by every mobile port (PortError)",
    request: {
      method: "POST",
      path: "/v1/auth/otp/request",
      headers: { "Content-Type": "application/json", "X-App-Attest": "<attest>", "X-Client-Platform": "ios" },
      body: { phone_e164: "nope" },
    },
    response: {
      status: 400,
      headers: { ...PROBLEM_CT, ...REQUEST_ID },
      body: problem(400, "validation_failed", { errors: eachLike({ pointer: like("/body/phone_e164"), code: like("invalid_format") }) }),
    },
  },
  {
    description: "a protected route without a token is a 401 problem",
    providerState: "anonymous device",
    openapi: "GET /v1/cart",
    derivedFrom: "apps/mobile session handling (refresh on 401)",
    request: { method: "GET", path: "/v1/cart", headers: { Accept: "application/json" } },
    response: { status: 401, headers: { ...PROBLEM_CT, ...REQUEST_ID }, body: problem(401, "unauthenticated") },
  },

  // ---- catalog read -------------------------------------------------------------------------
  {
    description: "unknown product is a 404 problem",
    providerState: "logged-in shopper",
    openapi: "GET /v1/products/{productId}",
    derivedFrom: "apps/mobile/src/features/pdp/model.ts PdpPort.load",
    request: { method: "GET", path: `/v1/products/${MISSING}`, headers: AUTH },
    response: { status: 404, headers: { ...PROBLEM_CT, ...REQUEST_ID }, body: problem(404, "not_found") },
  },
  {
    description: "search returns a cursor page",
    providerState: "logged-in shopper",
    openapi: "GET /v1/search",
    derivedFrom: "apps/mobile/src/features/search/model.ts SearchPort",
    request: { method: "GET", path: "/v1/search", query: { q: "dress" }, headers: AUTH },
    response: {
      status: 200,
      headers: { ...JSON_CT, ...REQUEST_ID },
      body: { items: like([]), page: { has_more: like(false) }, applied_filters: like({}) },
    },
  },

  // ---- bag ---------------------------------------------------------------------------------
  {
    description: "read my bag, with an ETag for If-Match edits",
    providerState: "logged-in shopper with an empty bag",
    openapi: "GET /v1/cart",
    derivedFrom: "apps/mobile/src/features/bag/model.ts BagPort.load",
    request: { method: "GET", path: "/v1/cart", headers: AUTH },
    response: {
      status: 200,
      headers: { ...JSON_CT, ...REQUEST_ID, ETag: regex('"abc"', '^"[^"]+"$') },
      body: { id: regex(UUID, UUID_RE), groups: like([]), line_count: like(0), updated_at: like(TS) },
    },
  },

  // ---- checkout ------------------------------------------------------------------------------
  {
    description: "quote with an unknown field is rejected as validation_failed (no mass assignment)",
    providerState: "logged-in shopper",
    openapi: "POST /v1/checkout/quote",
    derivedFrom: "apps/mobile/src/features/checkout/model.ts CheckoutPort.quote",
    request: { method: "POST", path: "/v1/checkout/quote", headers: { ...AUTH, "Content-Type": "application/json" }, body: { address_id: UUID, method: "card", total: "1" } },
    response: {
      status: 400,
      headers: { ...PROBLEM_CT, ...REQUEST_ID },
      body: problem(400, "validation_failed", { errors: eachLike({ pointer: like("/body"), code: like("unrecognized_keys") }) }),
    },
  },
  {
    description: "quote on an empty bag is a 409 bag_empty",
    providerState: "logged-in shopper with an empty bag",
    openapi: "POST /v1/checkout/quote",
    derivedFrom: "apps/mobile/src/features/checkout/model.ts CheckoutPort.quote",
    request: { method: "POST", path: "/v1/checkout/quote", headers: { ...AUTH, "Content-Type": "application/json" }, body: { address_id: MISSING, method: "card" } },
    response: { status: 409, headers: { ...PROBLEM_CT, ...REQUEST_ID }, body: problem(409, "bag_empty") },
  },
  {
    description: "checkout without an Idempotency-Key is refused",
    providerState: "logged-in shopper",
    openapi: "POST /v1/checkout",
    derivedFrom: "A2.5: every money write carries a client UUIDv7 key",
    request: { method: "POST", path: "/v1/checkout", headers: { ...AUTH, "Content-Type": "application/json", "X-App-Attest": "<attest>", "X-Client-Platform": "ios" }, body: {} },
    response: { status: 400, headers: { ...PROBLEM_CT, ...REQUEST_ID }, body: problem(400, "invalid_idempotency_key") },
  },

  // ---- orders -------------------------------------------------------------------------------
  {
    description: "unknown order group is 404 (also for another user's)",
    providerState: "logged-in shopper",
    openapi: "GET /v1/order-groups/{orderGroupId}",
    derivedFrom: "apps/mobile/src/features/orders/model.ts OrdersPort.group",
    request: { method: "GET", path: `/v1/order-groups/${MISSING}`, headers: AUTH },
    response: { status: 404, headers: { ...PROBLEM_CT, ...REQUEST_ID }, body: problem(404, "not_found") },
  },
  {
    description: "list my orders (Orders tab)",
    providerState: "logged-in shopper",
    openapi: "GET /v1/me/orders",
    derivedFrom: "apps/mobile/src/features/orders/model.ts OrdersPort.list",
    request: { method: "GET", path: "/v1/me/orders", headers: AUTH },
    response: { status: 200, headers: { ...JSON_CT, ...REQUEST_ID }, body: page(like([])) },
  },

  // ---- returns ------------------------------------------------------------------------------
  {
    description: "list my returns",
    providerState: "logged-in shopper",
    openapi: "GET /v1/me/returns",
    derivedFrom: "apps/mobile/src/features/returns/model.ts ReturnsPort.list",
    request: { method: "GET", path: "/v1/me/returns", headers: AUTH },
    response: { status: 200, headers: { ...JSON_CT, ...REQUEST_ID }, body: page(like([])) },
  },

  // ---- privacy ------------------------------------------------------------------------------
  {
    description: "read my consents",
    providerState: "logged-in shopper",
    openapi: "GET /v1/me/privacy/consents",
    derivedFrom: "apps/mobile/src/features/privacy-center/model.ts PrivacyPort",
    request: { method: "GET", path: "/v1/me/privacy/consents", headers: AUTH },
    response: { status: 200, headers: { ...JSON_CT, ...REQUEST_ID, ETag: regex('"abc"', '^"[^"]+"$') }, body: { consents: like([]) } },
  },
  {
    description: "request a data export (idempotent, async)",
    providerState: "logged-in shopper",
    openapi: "POST /v1/me/privacy/export",
    derivedFrom: "apps/mobile/src/features/privacy-center/model.ts PrivacyPort.requestExport",
    request: { method: "POST", path: "/v1/me/privacy/export", headers: { ...AUTH, "Content-Type": "application/json", "Idempotency-Key": IDEM }, body: {} },
    response: {
      status: 202,
      headers: { ...JSON_CT, ...REQUEST_ID },
      body: { id: regex(UUID, UUID_RE), status: like("queued"), requested_at: like(TS) },
    },
  },
];
