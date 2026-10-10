import { Controller, Delete, Get, HttpCode, Inject, Param, Post, Req, Body } from "@nestjs/common";
import { EgyptE164Schema, LocaleSchema, UuidSchema, maskPhone, toLanguage, DEFAULT_LOCALE } from "@outlet/validation";
import { z } from "zod";
import {
  Authorize,
  Idempotent,
  Public,
  RateLimit,
} from "../../../platform/decorators";
import { headerValue, type ApiRequest } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { Attestation } from "../application/common";
import type { GetSession, RevokeSession } from "../application/sessions";
import type { RequestOtp } from "../application/request-otp";
import type { VerifyOtp } from "../application/verify-otp";
import { GET_SESSION, REQUEST_OTP, REVOKE_SESSION, SESSION_RESOLVER, VERIFY_OTP } from "./tokens";

const OtpRequestSchema = z
  .object({
    phone_e164: EgyptE164Schema,
    channel: z.enum(["sms", "whatsapp"]).optional(),
    locale: LocaleSchema.optional(),
  })
  .strict();

const DeviceSchema = z
  .object({
    platform: z.enum(["ios", "android"]),
    install_id: UuidSchema,
    app_version: z.string().max(32).optional(),
    push_token: z.string().max(4096).optional(),
  })
  .strict();

const OtpVerifySchema = z
  .object({
    challenge_id: UuidSchema,
    code: z.string().regex(/^[0-9]{6}$/),
    device: DeviceSchema,
  })
  .strict();

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Attestation travels in X-App-Attest (OpenAPI `appAttest`). The client platform header is NOT in
 * the OpenAPI skeleton yet (proposed: X-Client-Platform); without it attestation cannot be
 * routed to App Attest or Play Integrity.
 */
function attestationFrom(req: ApiRequest, platformHint?: "ios" | "android"): Attestation | null {
  const token = headerValue(req, "x-app-attest");
  const platform = platformHint ?? headerValue(req, "x-client-platform");
  if (token === undefined || token.length === 0 || token.length > 8192) return null;
  if (platform !== "ios" && platform !== "android") return null;
  return { token, platform };
}

function attestationProblem(): ProblemError {
  return new ProblemError(403, "attestation-failed", "Device attestation failed", { code: "attestation_failed" });
}

@Controller()
export class AuthController {
  constructor(
    @Inject(REQUEST_OTP) private readonly requestOtp: RequestOtp,
    @Inject(VERIFY_OTP) private readonly verifyOtp: VerifyOtp,
    @Inject(GET_SESSION) private readonly getSession: GetSession,
    @Inject(REVOKE_SESSION) private readonly revokeSession: RevokeSession,
  ) {}

  @Post("auth/otp/request")
  @HttpCode(202)
  @Public()
  @Idempotent({ required: false })
  @RateLimit([
    { dimension: "phone", limit: 3, windowSeconds: 900 },
    { dimension: "device", limit: 10, windowSeconds: 86_400 },
    { dimension: "ip", limit: 30, windowSeconds: 3_600 },
  ])
  async requestOtpRoute(
    @Req() req: ApiRequest,
    @Body(new ZodPipe(OtpRequestSchema)) body: z.infer<typeof OtpRequestSchema>,
  ) {
    const locale = body.locale ?? DEFAULT_LOCALE;
    const result = await this.requestOtp.execute({
      phoneE164: body.phone_e164,
      channel: body.channel,
      language: toLanguage(locale),
      attestation: attestationFrom(req),
      sendKey: headerValue(req, "idempotency-key") ?? req.ctx?.requestId ?? "none",
    });
    switch (result.kind) {
      case "sent":
        return {
          challenge_id: result.challengeId,
          expires_at: iso(result.expiresAtMs),
          resend_available_at: iso(result.resendAvailableAtMs),
          attempts_remaining: result.attemptsRemaining,
          channel: result.channel,
        };
      case "attestation_failed":
        throw attestationProblem();
      case "country_not_allowed":
        throw new ProblemError(422, "country-not-allowed", "Phone numbers from this country are not supported", {
          code: "country_not_allowed",
        });
      case "rate_limited":
        throw Problems.rateLimited((result.retryAfterMs ?? 60_000) / 1000);
      case "delivery_failed":
        throw Problems.unavailable("otp_delivery_failed");
    }
  }

  @Post("auth/otp/verify")
  @HttpCode(200)
  @Public()
  // Deliberately not @Idempotent: a stored replay would persist the token pair for 24h.
  @RateLimit([
    { dimension: "challenge", limit: 5, windowSeconds: 300 },
    { dimension: "ip", limit: 30, windowSeconds: 3_600 },
  ])
  async verifyOtpRoute(
    @Req() req: ApiRequest,
    @Body(new ZodPipe(OtpVerifySchema)) body: z.infer<typeof OtpVerifySchema>,
  ) {
    const result = await this.verifyOtp.execute({
      challengeId: body.challenge_id,
      code: body.code,
      installId: body.device.install_id,
      platform: body.device.platform,
      language: "ar",
      attestation: attestationFrom(req, body.device.platform),
    });
    switch (result.kind) {
      case "ok":
        return {
          access_token: result.accessToken,
          access_expires_at: iso(result.accessExpiresAtMs),
          refresh_token: result.refreshToken,
          refresh_expires_at: iso(result.refreshExpiresAtMs),
          second_factor_required: false,
          user: {
            id: result.user.id,
            phone_masked: maskPhone(result.user.phoneE164),
            email: null,
            locale: result.user.language === "ar" ? "ar-EG" : "en",
            age_band: "unverified",
            limited_capacity: false,
            phone_verified: true,
            status: "active",
            created_at: iso(result.user.createdAtMs),
          },
        };
      case "attestation_failed":
        throw attestationProblem();
      case "expired":
        throw new ProblemError(422, "otp-expired", "The code has expired", { code: "otp_expired" });
      case "locked":
        throw Problems.rateLimited(300);
      case "invalid":
        throw new ProblemError(422, "otp-invalid", "The code is not valid", {
          code: "otp_invalid",
          ...(result.attemptsRemaining !== null ? { extensions: { attempts_remaining: result.attemptsRemaining } } : {}),
        });
    }
  }

  @Get("me/sessions/:sessionId")
  @Authorize({ action: "read", resourceType: "session", resolver: SESSION_RESOLVER, idParam: "sessionId" })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async getSessionRoute(@Req() req: ApiRequest, @Param("sessionId") sessionId: string) {
    const stored = await this.getSession.execute(sessionId);
    if (stored === null) throw Problems.notFound();
    return {
      id: stored.session.id,
      platform: stored.platform,
      created_at: iso(stored.session.createdAtMs),
      last_seen_at: iso(stored.session.lastUsedAtMs),
      current: req.principal?.claims.sid === stored.session.id,
    };
  }

  @Delete("me/sessions/:sessionId")
  @HttpCode(204)
  @Authorize({ action: "delete", resourceType: "session", resolver: SESSION_RESOLVER, idParam: "sessionId" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async revokeSessionRoute(@Param("sessionId") sessionId: string): Promise<void> {
    const revoked = await this.revokeSession.execute(sessionId);
    if (!revoked) throw Problems.notFound();
  }
}
