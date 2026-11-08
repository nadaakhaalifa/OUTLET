import { HttpException } from "@nestjs/common";
import { AdminAccessError } from "@outlet/admin-access";
import { AuthError } from "@outlet/auth-core";
import { CartError } from "@outlet/cart";
import { CatalogError } from "@outlet/catalog";
import { CheckoutError } from "@outlet/checkout";
import { InventoryError } from "@outlet/inventory";
import { MediaError } from "@outlet/media";
import { ReturnsError } from "@outlet/returns";
import { SellerAccountsError } from "@outlet/seller-accounts";
import { ShippingError } from "@outlet/shipping";
import { ZodError } from "zod";
import { ProblemError, Problems } from "./problem.js";
import type { ProblemViolation } from "./problem.js";

/** Zod issues to JSON-pointer violations. Messages are not copied (they may echo input); codes are. */
export const violations = (e: ZodError, root: string): ProblemViolation[] =>
  e.issues.slice(0, 50).map((i) => ({ path: `${root}${i.path.map((p) => `/${String(p)}`).join("")}`, code: i.code }));

const fastifyError = (e: unknown): { statusCode: number; code: string } | undefined => {
  if (typeof e !== "object" || e === null) return undefined;
  const statusCode = "statusCode" in e && typeof e.statusCode === "number" ? e.statusCode : undefined;
  const code = "code" in e && typeof e.code === "string" ? e.code : undefined;
  const isSyntax = e instanceof SyntaxError;
  if (statusCode === undefined || !(isSyntax || code?.startsWith("FST_") === true)) return undefined;
  return { statusCode, code: code ?? "SYNTAX" };
};

const catalogProblem = (e: CatalogError): ProblemError => {
  const errors = e.details.map((d) => ({ path: "/body", code: d }));
  switch (e.code) {
    case "not_found":
      return Problems.notFound();
    case "forbidden":
      return Problems.forbidden();
    case "conflict":
      return Problems.conflict("version-conflict");
    case "invalid_transition":
      return Problems.conflict("invalid-transition");
    case "validation":
      return Problems.unprocessable("validation-rule", errors);
    case "activation_blocked":
      return Problems.unprocessable("activation-blocked", errors);
  }
};

const mediaProblem = (e: MediaError): ProblemError => {
  switch (e.code) {
    case "too_large":
      return Problems.payloadTooLarge();
    case "not_found":
      return Problems.notFound();
    case "forbidden":
      return Problems.forbidden();
    case "av_unavailable":
      return Problems.unavailable("media-unavailable");
    default:
      return Problems.unprocessable(`media-${e.code.replaceAll("_", "-")}`, [{ path: "/body/file", code: e.code }]);
  }
};

const cartProblem = (e: CartError): ProblemError => {
  switch (e.code) {
    case "not_found":
      return Problems.notFound();
    case "forbidden":
      return Problems.forbidden();
    case "unavailable":
      return Problems.conflict("item-unavailable");
    case "idempotency_in_progress":
      return Problems.idempotencyInFlight();
    case "idempotency_conflict":
      return Problems.idempotencyKeyReuse();
    case "line_limit":
    case "qty_limit":
    case "invalid_qty":
    case "currency_mismatch":
      return Problems.unprocessable(e.code.replaceAll("_", "-"));
  }
};

const inventoryProblem = (e: InventoryError): ProblemError => {
  switch (e.code) {
    case "not_found":
      return Problems.notFound();
    case "forbidden":
      return Problems.forbidden();
    case "validation":
      return Problems.unprocessable("validation-rule", e.details.map((d) => ({ path: "/body", code: d })));
    case "conflict":
    case "invalid_transition":
    case "insufficient_stock":
      return Problems.conflict(e.code.replaceAll("_", "-"));
  }
};

/** The typed checkout code is the problem code; its HTTP status comes from the package (README section 5/8). Details carry codes only. */
const checkoutProblem = (e: CheckoutError): ProblemError => {
  const errors = [
    ...(e.details.deltas ?? []).map((d) => ({ path: "/quote", code: d.kind })),
    ...(e.details.shortfalls ?? []).map((s) => ({ path: `/cart/${s.skuId}`, code: "stock-shortfall" })),
  ];
  return new ProblemError(e.status, e.code, e.status === 404 ? "Resource not found" : "Checkout request rejected", errors.length === 0 ? {} : { errors: errors.slice(0, 50) });
};

const authProblem = (e: AuthError): ProblemError => {
  switch (e.code) {
    case "RATE_LIMITED":
      return Problems.rateLimited(e.retryAfterSeconds ?? 1);
    case "ACCESS_TOKEN_INVALID":
      return Problems.unauthenticated("invalid-token");
    // A refresh token that is unknown, used twice (family revoked), expired or revoked is one opaque 401: no oracle on which.
    case "REFRESH_INVALID":
    case "REFRESH_EXPIRED":
    case "REFRESH_REUSE":
    case "SESSION_REVOKED":
      return Problems.unauthenticated("refresh-rejected");
    case "INVALID_PHONE":
    case "UNSUPPORTED_COUNTRY":
      return Problems.unprocessable(e.code === "INVALID_PHONE" ? "invalid-phone" : "unsupported-country");
    case "DOB_REQUIRED":
    case "INVALID_DOB":
      return Problems.unprocessable(e.code === "DOB_REQUIRED" ? "dob-required" : "invalid-dob");
    case "UNDER_AGE":
      return Problems.forbidden("under-age");
    case "AGE_BLOCKED":
      return Problems.forbidden("age-blocked");
    case "USER_NOT_ACTIVE":
      return Problems.forbidden("user-not-active");
    case "OTP_LOCKED":
      return new ProblemError(429, "otp-locked", "Too many wrong codes", { retryAfterS: 300, headers: { "Retry-After": "300" } });
    case "OTP_SEND_FAILED":
      return Problems.unavailable("sms-unavailable");
    case "UNKNOWN_MARKET":
      return Problems.notFound("unknown-market");
    case "INSECURE_CONFIG":
      return Problems.internal();
    // Wrong, expired, consumed or unknown code and unknown device: opaque on purpose.
    default:
      return Problems.badRequest("auth-rejected");
  }
};

const adminProblem = (e: AdminAccessError): ProblemError => {
  switch (e.code) {
    case "NOT_FOUND":
      return Problems.notFound();
    case "FORBIDDEN":
    case "SELF_GRANT":
      return Problems.forbidden();
    case "SELF_APPROVAL":
      return Problems.forbidden("self-approval");
    case "REASON_CODE_REQUIRED":
      return Problems.forbidden("reason-code-required");
    case "INVALID_INPUT":
      return Problems.unprocessable("validation-rule");
    default:
      // already decided / not pending / expired / tampered / elevation states: one state-conflict family, the code names it.
      return Problems.conflict(e.code.toLowerCase().replaceAll("_", "-"));
  }
};

const shippingProblem = (e: ShippingError): ProblemError => {
  switch (e.code) {
    case "not_found":
      return Problems.notFound();
    case "forbidden":
      return Problems.forbidden();
    case "INVALID_TRANSITION":
    case "INTERNATIONAL_DISABLED":
    case "invalid_state":
      return Problems.conflict(e.code.toLowerCase().replaceAll("_", "-"));
    case "COURIER_UNAVAILABLE":
      return Problems.unavailable("courier-unavailable");
    case "INVALID_INPUT":
      return Problems.badRequest("webhook-malformed");
    default:
      // INVALID_ADDRESS, NO_COVERAGE, OVERWEIGHT: the request is well-formed but cannot be served; never a guessed fee.
      return Problems.unprocessable(e.code.toLowerCase().replaceAll("_", "-"));
  }
};

/** Eligibility refusals are 422 (the request cannot succeed as asked); wrong-state refusals are 409; existence of foreign objects is never revealed (404). */
const returnsProblem = (e: ReturnsError): ProblemError => {
  switch (e.code) {
    case "not_found":
      return Problems.notFound();
    case "forbidden":
      return Problems.forbidden();
    case "not_delivered":
    case "invalid_state":
    case "inspection_not_due":
    case "approval_required":
    case "refund_exceeds_paid":
    case "seller_net_negative":
    case "bnpl_provider_only":
      return Problems.conflict(e.code.replaceAll("_", "-"));
    case "refunds_disabled":
      return Problems.unavailable("refunds-disabled");
    case "commission_base_mismatch":
      return Problems.internal();
    default:
      // window_closed, disclosed_defect, non_returnable, photos_required, evidence_invalid, nothing_to_return, qty_exceeds_purchased
      return Problems.unprocessable(`return-${e.code.replaceAll("_", "-")}`);
  }
};

const sellerAccountsProblem = (e: SellerAccountsError): ProblemError => {
  const errors = e.details.map((d) => ({ path: "/gaps", code: d }));
  switch (e.code) {
    case "not_found":
      return Problems.notFound();
    case "forbidden":
      return Problems.forbidden();
    case "passkey_required":
      return Problems.forbidden("passkey-required");
    case "conflict":
    case "invalid_transition":
    case "last_owner":
      return Problems.conflict(e.code.replaceAll("_", "-"));
    default:
      // validation, kyc_incomplete (details = gap codes), signatory_under_21, reason_required
      return Problems.unprocessable(e.code.replaceAll("_", "-"), errors);
  }
};

/**
 * Every thrown value becomes one Problem. Unknown errors are a bare 500: their message is never sent.
 * Order matters: ProblemError first (already decided), then typed domain errors, then framework errors.
 */
export const toProblem = (e: unknown): ProblemError => {
  if (e instanceof ProblemError) return e;
  if (e instanceof CatalogError) return catalogProblem(e);
  if (e instanceof MediaError) return mediaProblem(e);
  if (e instanceof AuthError) return authProblem(e);
  if (e instanceof AdminAccessError) return adminProblem(e);
  if (e instanceof ReturnsError) return returnsProblem(e);
  if (e instanceof ShippingError) return shippingProblem(e);
  if (e instanceof SellerAccountsError) return sellerAccountsProblem(e);
  if (e instanceof CartError) return cartProblem(e);
  if (e instanceof CheckoutError) return checkoutProblem(e);
  if (e instanceof InventoryError) return inventoryProblem(e);
  if (e instanceof ZodError) return Problems.validation(violations(e, ""));
  const f = fastifyError(e);
  if (f !== undefined) {
    if (f.statusCode === 413) return Problems.payloadTooLarge();
    if (f.statusCode === 415) return Problems.unsupportedMediaType();
    if (f.statusCode >= 400 && f.statusCode < 500) return Problems.badRequest("malformed-request");
  }
  if (e instanceof HttpException) {
    const status = e.getStatus();
    if (status === 404) return Problems.notFound("route-not-found");
    if (status === 405) return new ProblemError(405, "method-not-allowed", "Method not allowed");
    if (status === 413) return Problems.payloadTooLarge();
    if (status === 415) return Problems.unsupportedMediaType();
    // Our code never throws Nest exceptions: a 4xx HttpException is the framework rejecting the request (e.g. bad JSON).
    if (status >= 400 && status < 500) return Problems.badRequest("malformed-request");
  }
  return Problems.internal();
};
