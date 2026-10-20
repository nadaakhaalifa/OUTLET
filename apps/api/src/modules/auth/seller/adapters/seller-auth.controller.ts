import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import type { Amr } from "@outlet/auth-core";
import { UuidSchema } from "@outlet/validation";
import { z } from "zod";
import { AllowSellerEnrol, AuthenticatedSelf, Idempotent, Public, RateLimit } from "../../../../platform/decorators";
import { headerValue, type ApiRequest } from "../../../../platform/http-types";
import { ProblemError, Problems } from "../../../../platform/problem";
import { ZodPipe } from "../../../../platform/zod.pipe";
import { attestDevice } from "../../application/common";
import { attestationFrom, iso } from "../../adapters/http-common";
import { AUTH_ATTESTATION } from "../../adapters/tokens";
import type { AttestationVerifier } from "@outlet/auth-core";
import type { SellerCaller, SellerPasskeys, SellerTotp } from "../application/factors";
import { NIL_INSTALL_ID, type SellerOtp } from "../application/otp";
import type { IssuedSellerSession, SellerSessions } from "../application/sessions";
import { SELLER_OTP, SELLER_PASSKEYS, SELLER_SESSIONS, SELLER_TOTP } from "./tokens";

const E164 = z.string().regex(/^\+[1-9][0-9]{7,14}$/);
const OtpRequestSchema = z
  .object({ phone_e164: E164, email: z.string().email().max(254), locale: z.enum(["ar", "en"]), channel: z.enum(["sms", "whatsapp"]).optional() })
  .strict();
const OtpVerifySchema = z.object({ challenge_id: UuidSchema, code: z.string().regex(/^[0-9]{6}$/) }).strict();
const Credential = z.looseObject({ id: z.string().min(1).max(1024) });
const RegisterSchema = z.object({ challenge_id: UuidSchema, credential: Credential, label: z.string().max(60).optional() }).strict();
const AssertOptionsSchema = z.object({ otp_proof: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const AssertSchema = z.object({ challenge_id: UuidSchema, credential: Credential }).strict();
const TotpConfirmSchema = z.object({ code: z.string().regex(/^[0-9]{6}$/) }).strict();
// A recovery code (XXXXX-XXXXX) is accepted in the same field as the 6 digit code.
const TotpAssertSchema = z
  .object({ otp_proof: z.string().regex(/^[0-9a-f]{64}$/), code: z.string().regex(/^([0-9]{6}|[0-9A-Za-z]{5}-[0-9A-Za-z]{5})$/) })
  .strict();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function installId(req: ApiRequest): string {
  const v = headerValue(req, "x-install-id");
  if (v === undefined) return NIL_INSTALL_ID;
  if (!UUID_RE.test(v)) throw Problems.validation([{ pointer: "/headers/x-install-id", code: "invalid_string" }]);
  return v.toLowerCase();
}

const WIRE_AMR = (amr: readonly Amr[]): string[] => [
  ...new Set(amr.flatMap((a) => (a === "otp_sms" || a === "otp_whatsapp" ? ["otp"] : a === "webauthn" || a === "passkey" ? ["webauthn"] : a === "totp" ? ["totp"] : []))),
];

function sessionBody(s: IssuedSellerSession): Record<string, unknown> {
  return {
    access_token: s.accessToken,
    refresh_token: s.refreshToken,
    expires_in: 600,
    seller_user_id: s.sellerUserId,
    amr: WIRE_AMR(s.amr),
    memberships: s.memberships.map((m) => ({ store_id: m.storeId, role: m.role })),
  };
}
export { sessionBody as sellerSessionBody };

const strongProblem = () => new ProblemError(409, "strong-factor-already-enrolled", "A strong factor is already enrolled", { code: "strong_factor_already_enrolled" });
const invalidAssertion = () =>
  new ProblemError(401, "invalid-seller-credentials", "The credentials were rejected", { code: "invalid_credentials", headers: { "WWW-Authenticate": "Bearer" } });

@Controller("seller/auth")
export class SellerAuthController {
  constructor(
    @Inject(SELLER_OTP) private readonly otp: SellerOtp,
    @Inject(SELLER_PASSKEYS) private readonly passkeys: SellerPasskeys,
    @Inject(SELLER_TOTP) private readonly totp: SellerTotp,
    @Inject(SELLER_SESSIONS) private readonly sessions: SellerSessions,
    @Inject(AUTH_ATTESTATION) private readonly attestation: AttestationVerifier,
  ) {}

  private caller(req: ApiRequest): SellerCaller {
    const claims = req.principal?.claims;
    if (claims === undefined) throw Problems.unauthenticated();
    return { sellerUserId: claims.sub, sessionId: claims.sid, kind: claims.scope === "seller:enrol" ? "enrol" : "full", amr: claims.amr, installId: installId(req) };
  }

  /** Mobile sends an attestation (verified when present); web has none and is keyed by IP. */
  private async clientKey(req: ApiRequest): Promise<string> {
    const att = attestationFrom(req);
    if (headerValue(req, "x-app-attest") !== undefined) {
      const key = await attestDevice(this.attestation, att);
      if (key === null) throw new ProblemError(403, "attestation-failed", "Device attestation failed", { code: "attestation_failed" });
      return key;
    }
    return `ip:${req.ip ?? "unknown"}`;
  }

  @Post("otp/request")
  @HttpCode(202)
  @Public()
  @Idempotent({ required: false })
  @RateLimit([
    { dimension: "phone", limit: 3, windowSeconds: 900 },
    { dimension: "ip", limit: 10, windowSeconds: 86_400 },
  ])
  async requestOtp(@Req() req: ApiRequest, @Body(new ZodPipe(OtpRequestSchema)) body: z.infer<typeof OtpRequestSchema>) {
    const r = await this.otp.request({
      phoneE164: body.phone_e164,
      email: body.email,
      language: body.locale,
      channel: body.channel,
      clientKey: await this.clientKey(req),
      sendKey: headerValue(req, "idempotency-key") ?? req.ctx?.requestId ?? "none",
    });
    switch (r.kind) {
      case "sent":
        return { challenge_id: r.challengeId, expires_in: r.expiresInSec, resend_after: r.resendAfterSec };
      case "attestation_failed":
        throw new ProblemError(403, "attestation-failed", "Device attestation failed", { code: "attestation_failed" });
      case "rate_limited":
        throw Problems.rateLimited((r.retryAfterMs ?? 60_000) / 1000);
      case "delivery_failed":
        throw Problems.unavailable("otp_delivery_failed");
      case "provider_not_configured":
        throw Problems.unavailable("provider_not_configured");
    }
  }

  @Post("otp/verify")
  @HttpCode(200)
  @Public()
  // Not @Idempotent: a stored replay would persist the token for 24h.
  @RateLimit([
    { dimension: "challenge", limit: 5, windowSeconds: 300 },
    { dimension: "ip", limit: 30, windowSeconds: 3_600 },
  ])
  async verifyOtp(@Req() req: ApiRequest, @Body(new ZodPipe(OtpVerifySchema)) body: z.infer<typeof OtpVerifySchema>) {
    const r = await this.otp.verify({ challengeId: body.challenge_id, code: body.code, clientKey: await this.clientKey(req), installId: installId(req) });
    switch (r.kind) {
      case "ok":
        return {
          enrol_token: r.enrolToken,
          ...(r.otpProof === null ? {} : { otp_proof: r.otpProof }),
          expires_in: r.expiresInSec,
          strong_factor_enrolled: r.strongFactorEnrolled,
          next_step: r.nextStep,
        };
      case "expired":
        throw new ProblemError(422, "otp-expired", "The code has expired", { code: "otp_expired" });
      case "locked":
        throw Problems.rateLimited(300);
      case "invalid":
        throw new ProblemError(422, "otp-invalid", "The code is not valid", {
          code: "otp_invalid",
          ...(r.attemptsRemaining !== null ? { extensions: { attempts_remaining: r.attemptsRemaining } } : {}),
        });
    }
  }

  @Post("passkey/register/options")
  @HttpCode(200)
  @AuthenticatedSelf("seller_api")
  @AllowSellerEnrol()
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 3_600 }])
  async registerOptions(@Req() req: ApiRequest) {
    const r = await this.passkeys.registerOptions(this.caller(req));
    if (r.kind === "not_found") throw Problems.unauthenticated();
    if (r.kind === "already_enrolled") throw strongProblem();
    return { challenge_id: r.challengeId, public_key: r.publicKey };
  }

  @Post("passkey/register")
  @HttpCode(200)
  @AuthenticatedSelf("seller_api")
  @AllowSellerEnrol()
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 3_600 }])
  async register(@Req() req: ApiRequest, @Body(new ZodPipe(RegisterSchema)) body: z.infer<typeof RegisterSchema>) {
    const r = await this.passkeys.register(this.caller(req), { challengeId: body.challenge_id, credential: body.credential, label: body.label ?? null });
    switch (r.kind) {
      case "ok":
        return sessionBody(r);
      case "not_found":
        throw Problems.unauthenticated();
      case "already_enrolled":
        throw strongProblem();
      case "challenge_invalid":
        throw new ProblemError(422, "invalid-challenge", "The challenge is unknown, expired or already used", { code: "invalid_challenge" });
      case "already_registered":
        throw new ProblemError(409, "credential-exists", "This passkey is already registered", { code: "credential_exists" });
      case "rejected":
        throw new ProblemError(422, "passkey-rejected", "The passkey response was rejected", { code: "passkey_rejected" });
    }
  }

  @Post("totp/enrol")
  @HttpCode(200)
  @AuthenticatedSelf("seller_api")
  @AllowSellerEnrol()
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 5, windowSeconds: 3_600 }])
  async totpEnrol(@Req() req: ApiRequest) {
    const r = await this.totp.enrol(this.caller(req));
    switch (r.kind) {
      case "ok":
        return { otpauth_uri: r.otpauthUri, recovery_codes: r.recoveryCodes };
      case "not_found":
        throw Problems.unauthenticated();
      case "already_enrolled":
        throw strongProblem();
      case "already_active":
        throw new ProblemError(409, "totp-already-enrolled", "TOTP is already enrolled", { code: "totp_already_enrolled" });
    }
  }

  @Post("totp/confirm")
  @HttpCode(200)
  @AuthenticatedSelf("seller_api")
  @AllowSellerEnrol()
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 900 }])
  async totpConfirm(@Req() req: ApiRequest, @Body(new ZodPipe(TotpConfirmSchema)) body: z.infer<typeof TotpConfirmSchema>) {
    const r = await this.totp.confirm(this.caller(req), body.code);
    switch (r.kind) {
      case "ok":
        return sessionBody(r);
      case "not_found":
        throw Problems.unauthenticated();
      case "already_enrolled":
        throw strongProblem();
      case "no_pending":
        throw new ProblemError(409, "no-pending-totp", "No TOTP enrolment is pending", { code: "no_pending_totp" });
      case "invalid":
        throw new ProblemError(422, "totp-invalid", "The code is not valid", { code: "totp_invalid" });
      case "locked":
        throw Problems.rateLimited(r.retryAfterMs / 1000);
    }
  }

  @Post("passkey/assert/options")
  @HttpCode(200)
  @Public()
  @RateLimit([{ dimension: "ip", limit: 20, windowSeconds: 900 }])
  async assertOptions(@Body(new ZodPipe(AssertOptionsSchema)) body: z.infer<typeof AssertOptionsSchema>) {
    const r = await this.passkeys.assertOptions(body.otp_proof);
    if (r.kind === "ok") return { challenge_id: r.challengeId, public_key: r.publicKey };
    if (r.kind === "no_passkey") throw new ProblemError(422, "no-passkey", "No passkey is enrolled", { code: "no_passkey" });
    throw invalidAssertion();
  }

  @Post("passkey/assert")
  @HttpCode(200)
  @Public()
  @RateLimit([
    { dimension: "challenge", limit: 5, windowSeconds: 300 },
    { dimension: "ip", limit: 20, windowSeconds: 900 },
  ])
  async assertPasskey(@Req() req: ApiRequest, @Body(new ZodPipe(AssertSchema)) body: z.infer<typeof AssertSchema>) {
    const r = await this.passkeys.assert({ challengeId: body.challenge_id, credentialId: body.credential.id, credential: body.credential, installId: installId(req) });
    if (r.kind !== "ok") throw invalidAssertion();
    return sessionBody(r);
  }

  @Post("totp/assert")
  @HttpCode(200)
  @Public()
  @RateLimit([{ dimension: "ip", limit: 10, windowSeconds: 900 }])
  async assertTotp(@Req() req: ApiRequest, @Body(new ZodPipe(TotpAssertSchema)) body: z.infer<typeof TotpAssertSchema>) {
    const r = await this.totp.assert({ otpProof: body.otp_proof, code: body.code, installId: installId(req) });
    if (r.kind === "ok") return sessionBody(r);
    if (r.kind === "locked") throw Problems.rateLimited(r.retryAfterMs / 1000);
    throw invalidAssertion();
  }

  // ---- Sessions (additive to the contract) ---------------------------------------------------

  @Get("sessions")
  @AuthenticatedSelf("seller_api")
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async list(@Req() req: ApiRequest) {
    const id = req.principal?.actor.id;
    if (id === undefined) throw Problems.unauthenticated();
    const rows = await this.sessions.list(id);
    return {
      items: rows.map((s) => ({
        id: s.session.id,
        kind: s.session.kind,
        created_at: iso(s.session.createdAtMs),
        last_seen_at: iso(s.session.lastUsedAtMs),
        current: req.principal?.claims.sid === s.session.id,
      })),
      page: { next_cursor: null, has_more: false },
    };
  }

  @Delete("sessions/:sessionId")
  @HttpCode(204)
  @AuthenticatedSelf("seller_api")
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async revoke(@Req() req: ApiRequest, @Param("sessionId") sessionId: string): Promise<void> {
    const id = req.principal?.actor.id;
    if (id === undefined) throw Problems.unauthenticated();
    if (!(await this.sessions.revoke(id, sessionId, "user_revoked"))) throw Problems.notFound();
  }

  @Post("logout")
  @HttpCode(204)
  @AuthenticatedSelf("seller_api")
  @AllowSellerEnrol()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async logout(@Req() req: ApiRequest): Promise<void> {
    const c = req.principal;
    if (c === undefined || c === null) throw Problems.unauthenticated();
    await this.sessions.revoke(c.actor.id, c.claims.sid, "logout");
  }
}
