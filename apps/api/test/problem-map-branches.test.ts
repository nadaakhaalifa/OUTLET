import { HttpException } from "@nestjs/common";
import { AuthError } from "@outlet/auth-core";
import type { AuthErrorCode } from "@outlet/auth-core";
import { CartError } from "@outlet/cart";
import type { CartErrorCode } from "@outlet/cart";
import { CatalogError } from "@outlet/catalog";
import type { CatalogErrorCode } from "@outlet/catalog";
import { CheckoutError } from "@outlet/checkout";
import type { CheckoutErrorCode } from "@outlet/checkout";
import { MediaError } from "@outlet/media";
import type { MediaErrorCode } from "@outlet/media";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toProblem } from "../src/platform/problem-map.js";
import { ProblemError } from "../src/platform/problem.js";

const shape = (e: unknown): [number, string] => {
  const p = toProblem(e);
  return [p.status, p.code];
};

describe("toProblem: every typed domain code has one stable status and code", () => {
  it.each<[CatalogErrorCode, number, string]>([
    ["not_found", 404, "not-found"], ["forbidden", 403, "forbidden"], ["conflict", 409, "version-conflict"],
    ["invalid_transition", 409, "invalid-transition"], ["validation", 422, "validation-rule"], ["activation_blocked", 422, "activation-blocked"],
  ])("catalog %s", (code, status, problem) => {
    expect(shape(new CatalogError(code, "x", ["d1"]))).toEqual([status, problem]);
  });
  it("catalog details become body violations, codes only", () => {
    expect(toProblem(new CatalogError("activation_blocked", "secret message", ["no_photo", "no_price"])).options.errors).toEqual([{ path: "/body", code: "no_photo" }, { path: "/body", code: "no_price" }]);
  });

  it.each<[MediaErrorCode, number, string]>([
    ["too_large", 413, "payload-too-large"], ["not_found", 404, "not-found"], ["forbidden", 403, "forbidden"], ["av_unavailable", 503, "media-unavailable"],
    ["type_not_allowed", 422, "media-type-not-allowed"], ["mime_mismatch", 422, "media-mime-mismatch"], ["invalid_image", 422, "media-invalid-image"],
    ["variant_too_large", 422, "media-variant-too-large"], ["ttl_invalid", 422, "media-ttl-invalid"], ["reason_required", 422, "media-reason-required"], ["not_ready", 422, "media-not-ready"],
  ])("media %s", (code, status, problem) => {
    expect(shape(new MediaError(code))).toEqual([status, problem]);
  });

  it.each<[CartErrorCode, number, string]>([
    ["not_found", 404, "not-found"], ["forbidden", 403, "forbidden"], ["unavailable", 409, "item-unavailable"], ["idempotency_in_progress", 409, "idempotency-in-flight"],
    ["idempotency_conflict", 422, "idempotency-key-reuse"], ["line_limit", 422, "line-limit"], ["qty_limit", 422, "qty-limit"], ["invalid_qty", 422, "invalid-qty"], ["currency_mismatch", 422, "currency-mismatch"],
  ])("cart %s", (code, status, problem) => {
    expect(shape(new CartError(code, "x"))).toEqual([status, problem]);
  });

  it.each<[AuthErrorCode, number, string]>([
    ["ACCESS_TOKEN_INVALID", 401, "invalid-token"], ["REFRESH_INVALID", 401, "refresh-rejected"], ["REFRESH_EXPIRED", 401, "refresh-rejected"], ["REFRESH_REUSE", 401, "refresh-rejected"], ["SESSION_REVOKED", 401, "refresh-rejected"],
    ["INVALID_PHONE", 422, "invalid-phone"], ["UNSUPPORTED_COUNTRY", 422, "unsupported-country"], ["DOB_REQUIRED", 422, "dob-required"], ["INVALID_DOB", 422, "invalid-dob"],
    ["UNDER_AGE", 403, "under-age"], ["AGE_BLOCKED", 403, "age-blocked"], ["USER_NOT_ACTIVE", 403, "user-not-active"], ["OTP_LOCKED", 429, "otp-locked"],
    ["OTP_SEND_FAILED", 503, "sms-unavailable"], ["UNKNOWN_MARKET", 404, "unknown-market"], ["INSECURE_CONFIG", 500, "internal-error"],
    ["OTP_NOT_FOUND", 400, "auth-rejected"], ["OTP_EXPIRED", 400, "auth-rejected"], ["OTP_INVALID", 400, "auth-rejected"], ["OTP_CONSUMED", 400, "auth-rejected"], ["INVALID_DEVICE", 400, "auth-rejected"],
  ])("auth %s", (code, status, problem) => {
    expect(shape(new AuthError(code, "x"))).toEqual([status, problem]);
  });
  it("auth RATE_LIMITED carries Retry-After (rounded up, at least 1) and OTP_LOCKED fixes 300 s", () => {
    expect(toProblem(new AuthError("RATE_LIMITED", "x", { retryAfterSeconds: 41.2 })).options.headers).toEqual({ "Retry-After": "42" });
    expect(toProblem(new AuthError("RATE_LIMITED", "x")).options.retryAfterS).toBe(1);
    expect(toProblem(new AuthError("OTP_LOCKED", "x")).options.retryAfterS).toBe(300);
  });

  it("checkout takes its status from the package, with price deltas and stock shortfalls as codes only", () => {
    const all: CheckoutErrorCode[] = ["quote-token-invalid", "quote-expired", "price-changed", "stock-shortfall", "method-unavailable", "address-not-found", "empty-bag", "idempotency-conflict", "credit-insufficient", "cod-credit-unsupported", "cod-not-allowed", "store-not-onboarded", "payment-declined", "psp-unavailable", "not-found", "invalid-state", "webhook-rejected", "invalid-quantity"];
    for (const code of all) {
      const e = new CheckoutError(code, "internal detail");
      const p = toProblem(e);
      expect(p.code).toBe(code);
      expect(p.status).toBe(e.status);
      expect(p.title).toBe(e.status === 404 ? "Resource not found" : "Checkout request rejected");
    }
    const withDetails = toProblem(new CheckoutError("price-changed", "x", { deltas: [{ kind: "price" } as never], shortfalls: [{ skuId: "s1", locationId: "l", requested: 2, available: 1 }] }));
    expect(withDetails.options.errors).toEqual([{ path: "/quote", code: "price" }, { path: "/cart/s1", code: "stock-shortfall" }]);
    expect(toProblem(new CheckoutError("quote-token-invalid", "x", {}, 409)).status).toBe(409);
  });
});

describe("toProblem: framework and unknown errors", () => {
  it("a ProblemError passes through untouched; ZodError becomes 400 validation with JSON pointers", () => {
    const p = new ProblemError(418, "teapot", "teapot");
    expect(toProblem(p)).toBe(p);
    const r = z.strictObject({ a: z.string(), b: z.object({ c: z.number() }) }).safeParse({ a: 1, b: { c: "x" } });
    expect(r.success).toBe(false);
    if (!r.success) {
      const out = toProblem(r.error);
      expect(out.status).toBe(400);
      expect(out.options.errors?.map((x) => x.path)).toEqual(["/a", "/b/c"]);
    }
  });
  it.each<[number, number, string]>([[404, 404, "route-not-found"], [405, 405, "method-not-allowed"], [413, 413, "payload-too-large"], [415, 415, "unsupported-media-type"], [400, 400, "malformed-request"], [422, 400, "malformed-request"], [500, 500, "internal-error"], [503, 500, "internal-error"]])(
    "HttpException %i",
    (status, expectedStatus, code) => {
      expect(shape(new HttpException("x", status))).toEqual([expectedStatus, code]);
    },
  );
  it("fastify errors: FST_ codes and JSON syntax errors by status; non-4xx or foreign codes fall to 500", () => {
    const fst = (statusCode: number, code: string) => Object.assign(new Error("x"), { statusCode, code });
    expect(shape(fst(413, "FST_ERR_CTP_BODY_TOO_LARGE"))).toEqual([413, "payload-too-large"]);
    expect(shape(fst(415, "FST_ERR_CTP_INVALID_MEDIA_TYPE"))).toEqual([415, "unsupported-media-type"]);
    expect(shape(fst(400, "FST_ERR_VALIDATION"))).toEqual([400, "malformed-request"]);
    expect(shape(Object.assign(new SyntaxError("bad json"), { statusCode: 400 }))).toEqual([400, "malformed-request"]);
    expect(shape(fst(500, "FST_ERR_X"))).toEqual([500, "internal-error"]);
    expect(shape(Object.assign(new Error("x"), { statusCode: 400, code: "ECONNRESET" }))).toEqual([500, "internal-error"]);
    expect(shape(Object.assign(new Error("x"), { statusCode: "400", code: "FST_X" }))).toEqual([500, "internal-error"]);
    expect(shape("string error")).toEqual([500, "internal-error"]);
    expect(shape(null)).toEqual([500, "internal-error"]);
  });
});
