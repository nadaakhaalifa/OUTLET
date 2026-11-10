import { AdminAccessError } from "@outlet/admin-access";
import type { AdminAccessErrorCode } from "@outlet/admin-access";
import { AuthError } from "@outlet/auth-core";
import { CartError } from "@outlet/cart";
import { InventoryError } from "@outlet/inventory";
import { ReturnsError } from "@outlet/returns";
import type { ReturnsErrorCode } from "@outlet/returns";
import { SellerAccountsError } from "@outlet/seller-accounts";
import type { SellerAccountsErrorCode } from "@outlet/seller-accounts";
import { ShippingError } from "@outlet/shipping";
import type { ShippingErrorCode } from "@outlet/shipping";
import { describe, expect, it } from "vitest";
import { toProblem } from "../src/platform/problem-map.js";

const shape = (e: unknown): [number, string] => {
  const p = toProblem(e);
  return [p.status, p.code];
};

describe("toProblem: inventory, cart, admin-access, shipping, returns, seller-accounts", () => {
  it("inventory", () => {
    expect(shape(new InventoryError("not_found", "x"))).toEqual([404, "not-found"]);
    expect(shape(new InventoryError("forbidden", "x"))).toEqual([403, "forbidden"]);
    expect(shape(new InventoryError("validation", "x", ["a"]))).toEqual([422, "validation-rule"]);
    expect(toProblem(new InventoryError("validation", "x", ["a"])).options.errors).toEqual([{ path: "/body", code: "a" }]);
    expect(shape(new InventoryError("insufficient_stock", "x"))).toEqual([409, "insufficient-stock"]);
    expect(shape(new InventoryError("invalid_transition", "x"))).toEqual([409, "invalid-transition"]);
  });
  it("cart", () => {
    expect(shape(new CartError("unavailable", "x"))).toEqual([409, "item-unavailable"]);
    expect(shape(new CartError("idempotency_in_progress", "x"))).toEqual([409, "idempotency-in-flight"]);
    expect(shape(new CartError("idempotency_conflict", "x"))).toEqual([422, "idempotency-key-reuse"]);
    expect(shape(new CartError("line_limit", "x"))).toEqual([422, "line-limit"]);
    expect(shape(new CartError("currency_mismatch", "x"))).toEqual([422, "currency-mismatch"]);
  });
  it.each<[AdminAccessErrorCode, number, string]>([
    ["NOT_FOUND", 404, "not-found"], ["FORBIDDEN", 403, "forbidden"], ["SELF_GRANT", 403, "forbidden"], ["SELF_APPROVAL", 403, "self-approval"],
    ["REASON_CODE_REQUIRED", 403, "reason-code-required"], ["INVALID_INPUT", 422, "validation-rule"], ["ALREADY_DECIDED", 409, "already-decided"],
    ["APPROVAL_EXPIRED", 409, "approval-expired"], ["DUAL_APPROVAL_REQUIRED", 409, "dual-approval-required"],
  ])("admin-access %s", (code, status, problem) => {
    expect(shape(new AdminAccessError(code))).toEqual([status, problem]);
  });
  it.each<[ShippingErrorCode, number, string]>([
    ["not_found", 404, "not-found"], ["forbidden", 403, "forbidden"], ["INVALID_TRANSITION", 409, "invalid-transition"], ["INTERNATIONAL_DISABLED", 409, "international-disabled"],
    ["COURIER_UNAVAILABLE", 503, "courier-unavailable"], ["INVALID_INPUT", 400, "webhook-malformed"], ["INVALID_ADDRESS", 422, "invalid-address"], ["NO_COVERAGE", 422, "no-coverage"],
    ["OVERWEIGHT", 422, "overweight"],
  ])("shipping %s", (code, status, problem) => {
    expect(shape(new ShippingError(code, "x"))).toEqual([status, problem]);
  });
  // ShippingError documents `invalid_state` as 409 (packages/shipping/src/domain/errors.ts) but the mapper sends it to the 422 default.
  it("shipping invalid_state is a 409 state conflict as documented", () => {
    expect(toProblem(new ShippingError("invalid_state", "x")).status).toBe(409);
  });
  it.each<[ReturnsErrorCode, number, string]>([
    ["not_found", 404, "not-found"], ["forbidden", 403, "forbidden"], ["not_delivered", 409, "not-delivered"], ["invalid_state", 409, "invalid-state"],
    ["approval_required", 409, "approval-required"], ["refund_exceeds_paid", 409, "refund-exceeds-paid"], ["bnpl_provider_only", 409, "bnpl-provider-only"], ["request_bnpl_provider_only", 422, "return-bnpl-provider-only"],
    ["refunds_disabled", 503, "refunds-disabled"], ["commission_base_mismatch", 500, "internal-error"], ["window_closed", 422, "return-window-closed"],
    ["photos_required", 422, "return-photos-required"], ["non_returnable", 422, "return-non-returnable"],
  ])("returns %s", (code, status, problem) => {
    expect(shape(new ReturnsError(code))).toEqual([status, problem]);
  });
  it.each<[SellerAccountsErrorCode, number, string]>([
    ["not_found", 404, "not-found"], ["forbidden", 403, "forbidden"], ["passkey_required", 403, "passkey-required"], ["conflict", 409, "conflict"],
    ["invalid_transition", 409, "invalid-transition"], ["last_owner", 409, "last-owner"], ["kyc_incomplete", 422, "kyc-incomplete"],
    ["signatory_under_21", 422, "signatory-under-21"], ["reason_required", 422, "reason-required"], ["validation", 422, "validation"],
  ])("seller-accounts %s", (code, status, problem) => {
    expect(shape(new SellerAccountsError(code, "x"))).toEqual([status, problem]);
  });
  it("seller-accounts gaps become /gaps violations, codes only", () => {
    expect(toProblem(new SellerAccountsError("kyc_incomplete", "secret", ["iban", "tax_card"])).options.errors).toEqual([{ path: "/gaps", code: "iban" }, { path: "/gaps", code: "tax_card" }]);
  });
  it("auth codes: rate limit default, locked, send failure, unknown market, age and phone", () => {
    expect(toProblem(new AuthError("RATE_LIMITED", "x")).options.retryAfterS).toBe(1);
    expect(toProblem(new AuthError("RATE_LIMITED", "x", { retryAfterSeconds: 42 })).options.retryAfterS).toBe(42);
    expect(shape(new AuthError("OTP_LOCKED", "x"))).toEqual([429, "otp-locked"]);
    expect(shape(new AuthError("OTP_SEND_FAILED", "x"))).toEqual([503, "sms-unavailable"]);
    expect(shape(new AuthError("UNKNOWN_MARKET", "x"))).toEqual([404, "unknown-market"]);
    expect(shape(new AuthError("INVALID_PHONE", "x"))).toEqual([422, "invalid-phone"]);
    expect(shape(new AuthError("UNSUPPORTED_COUNTRY", "x"))).toEqual([422, "unsupported-country"]);
    expect(shape(new AuthError("DOB_REQUIRED", "x"))).toEqual([422, "dob-required"]);
    expect(shape(new AuthError("INVALID_DOB", "x"))).toEqual([422, "invalid-dob"]);
    expect(shape(new AuthError("UNDER_AGE", "x"))).toEqual([403, "under-age"]);
    expect(shape(new AuthError("AGE_BLOCKED", "x"))).toEqual([403, "age-blocked"]);
    expect(shape(new AuthError("USER_NOT_ACTIVE", "x"))).toEqual([403, "user-not-active"]);
    expect(shape(new AuthError("INSECURE_CONFIG", "x"))).toEqual([500, "internal-error"]);
    expect(shape(new AuthError("REFRESH_REUSE", "x"))).toEqual([401, "refresh-rejected"]);
    expect(shape(new AuthError("ACCESS_TOKEN_INVALID", "x"))).toEqual([401, "invalid-token"]);
  });
});
