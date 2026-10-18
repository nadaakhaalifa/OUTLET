import { Controller, Delete, Get, HttpCode, Inject, Param, Post, Req, Body } from "@nestjs/common";
import { EgyptE164Schema, LocaleSchema, UuidSchema, toLanguage, DEFAULT_LOCALE } from "@outlet/validation";
import { z } from "zod";
import {
  AuthenticatedSelf,
  Authorize,
  Idempotent,
  Public,
  RateLimit,
} from "../../../platform/decorators";
import { headerValue, type ApiRequest } from "../../../platform/http-types";
import {
  accountUnavailableProblem,
  ageBlockedProblem,
  ageGateRequiredProblem,
  attestationFrom,
  attestationProblem,
  DeviceSchema,
  iso,
  noAccountProblem,
  SignInModeSchema,
  stepUpProblem,
  tokenPair,
  toMe,
} from "./http-common";
import { ProblemError, Problems } from "../../../platform/problem";
import { assertGuestBrowsingEnabled, type PublicReadGate } from "../../../platform/public-read";
import { GUEST_BROWSING_GATE } from "../../../platform/tokens";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { GetMe, GetSession, RevokeSession } from "../application/sessions";
import type { RequestOtp } from "../application/request-otp";
import type { VerifyOtp } from "../application/verify-otp";
import { GET_ME, GET_SESSION, REQUEST_OTP, REVOKE_SESSION, SESSION_RESOLVER, VERIFY_OTP } from "./tokens";

const OtpRequestSchema = z
  .object({
    phone_e164: EgyptE164Schema,
    channel: z.enum(["sms", "whatsapp"]).optional(),
    locale: LocaleSchema.optional(),
  })
  .strict();

const OtpVerifySchema = z
  .object({
    challenge_id: UuidSchema,
    code: z.string().regex(/^[0-9]{6}$/),
    device: DeviceSchema,
    /** Omitted = create (checkout sign-up). existing_only = quiet sign-in, never creates an account (G-9). */
    mode: SignInModeSchema.optional(),
  })
  .strict();

@Controller()
export class AuthController {
  constructor(
    @Inject(REQUEST_OTP) private readonly requestOtp: RequestOtp,
    @Inject(VERIFY_OTP) private readonly verifyOtp: VerifyOtp,
    @Inject(GET_SESSION) private readonly getSession: GetSession,
    @Inject(REVOKE_SESSION) private readonly revokeSession: RevokeSession,
    @Inject(GET_ME) private readonly getMe: GetMe,
    /** `flag.guest_browsing`: the sign-in-only mode is guest-specific and fails closed (404) while blocked. */
    @Inject(GUEST_BROWSING_GATE) private readonly guestGate: PublicReadGate,
  ) {}

  /** Profile summary of the caller (OpenAPI Me, minus P2 contact fields). Never P3. */
  @Get("me")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async meRoute(@Req() req: ApiRequest) {
    const userId = req.principal?.actor.id;
    if (userId === undefined) throw Problems.unauthenticated();
    const user = await this.getMe.execute(userId);
    if (user === null) throw Problems.unauthenticated();
    const full = toMe(user);
    return {
      id: full["id"],
      locale: full["locale"],
      age_band: full["age_band"],
      limited_capacity: full["limited_capacity"],
      phone_verified: full["phone_verified"],
      status: full["status"],
      created_at: full["created_at"],
    };
  }

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
      case "age_gate_required":
        throw ageGateRequiredProblem();
      case "age_blocked":
        throw ageBlockedProblem(result.blockedUntilMs);
      case "country_not_allowed":
        throw new ProblemError(422, "country-not-allowed", "Phone numbers from this country are not supported", {
          code: "country_not_allowed",
        });
      case "rate_limited":
        throw Problems.rateLimited((result.retryAfterMs ?? 60_000) / 1000);
      case "delivery_failed":
        throw Problems.unavailable("otp_delivery_failed");
      case "provider_not_configured":
        throw Problems.unavailable("provider_not_configured");
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
    if (body.mode === "existing_only") await assertGuestBrowsingEnabled(this.guestGate);
    const result = await this.verifyOtp.execute({
      challengeId: body.challenge_id,
      code: body.code,
      installId: body.device.install_id,
      platform: body.device.platform,
      language: "ar",
      attestation: attestationFrom(req, body.device.platform),
      mode: body.mode ?? "create",
    });
    switch (result.kind) {
      case "ok":
        return tokenPair(result);
      case "account_unavailable":
        throw accountUnavailableProblem();
      case "no_account":
        throw noAccountProblem();
      case "step_up_required":
        throw stepUpProblem(result.challenge);
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
    const revoked = await this.revokeSession.execute(sessionId, "user_revoked");
    if (!revoked) throw Problems.notFound();
  }
}
