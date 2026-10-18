import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req } from "@nestjs/common";
import { UuidSchema, toLanguage, DEFAULT_LOCALE, LocaleSchema } from "@outlet/validation";
import { z } from "zod";
import { sellerSessionBody } from "../seller/adapters/seller-auth.controller";
import { SELLER_REFRESH } from "../seller/adapters/tokens";
import type { SellerRefresh } from "../seller/application/sessions";
import { AuthenticatedSelf, Public, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { AgeGate } from "../application/age-gate";
import type { PasskeyService } from "../application/passkeys";
import type { ListSessions, RefreshSession, RevokeSession } from "../application/sessions";
import type { SocialLogin, SocialLoginFailure } from "../application/social-login";
import {
  ageBlockedProblem,
  ageGateRequiredProblem,
  attestationFrom,
  attestationProblem,
  DeviceSchema,
  PasskeyDeviceSchema,
  iso,
  tokenPair,
} from "./http-common";
import { AGE_GATE, LIST_SESSIONS, PASSKEYS, REFRESH_SESSION, REVOKE_SESSION, SOCIAL_LOGIN } from "./tokens";

const AgeGateSchema = z
  .object({
    dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** Client-side stable device identifier, hashed on the device (64 hex). Re-hashed with a server key. */
    device_id_hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const SocialLoginSchema = z
  .object({
    id_token: z.string().min(20).max(8192),
    nonce: z.string().min(8).max(256),
    device: DeviceSchema,
    locale: LocaleSchema.optional(),
  })
  .strict();

const RefreshSchema = z
  .object({
    refresh_token: z.string().min(16).max(256),
    /** Mobile only. Web sessions are bound by the X-Admin-Install header instead and ignore this. */
    device_install_id: UuidSchema.optional(),
  })
  .strict();

const WebAuthnCredential = z.looseObject({ id: z.string().min(1).max(1024) });

const PasskeyRegisterSchema = z
  .object({ challenge_id: UuidSchema, credential: WebAuthnCredential })
  .strict();

const PasskeyAssertSchema = z
  .object({ challenge_id: UuidSchema, credential: WebAuthnCredential, device: PasskeyDeviceSchema })
  .strict();

const SessionListQuerySchema = z
  .object({ cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(50).optional() })
  .strict();

const SOCIAL_CODES: Readonly<Record<Exclude<SocialLoginFailure, "provider_unavailable">, string>> = {
  invalid_token: "invalid_identity_token",
  expired: "identity_token_expired",
  nonce_mismatch: "nonce_mismatch",
  nonce_reused: "nonce_reused",
  audience_mismatch: "audience_mismatch",
  issuer_mismatch: "issuer_mismatch",
};

function socialProblem(reason: SocialLoginFailure): ProblemError {
  if (reason === "provider_unavailable") return Problems.unavailable("identity_provider_unavailable");
  return new ProblemError(401, "invalid-identity-token", "The identity token was rejected", {
    code: SOCIAL_CODES[reason],
  });
}

const invalidRefresh = (): ProblemError =>
  new ProblemError(401, "invalid-refresh-token", "The refresh token is not valid", {
    code: "invalid_refresh_token",
    headers: { "WWW-Authenticate": "Bearer" },
  });

@Controller()
export class IdentityController {
  constructor(
    @Inject(AGE_GATE) private readonly ageGate: AgeGate,
    @Inject(SOCIAL_LOGIN) private readonly social: SocialLogin,
    @Inject(PASSKEYS) private readonly passkeys: PasskeyService,
    @Inject(REFRESH_SESSION) private readonly refresh: RefreshSession,
    @Inject(REVOKE_SESSION) private readonly revoke: RevokeSession,
    @Inject(LIST_SESSIONS) private readonly listSessions: ListSessions,
    @Inject(SELLER_REFRESH) private readonly sellerRefresh: SellerRefresh,
  ) {}

  // ---- Age gate -------------------------------------------------------------------------

  @Post("auth/age-gate")
  @HttpCode(200)
  @Public()
  @RateLimit([
    { dimension: "device", limit: 10, windowSeconds: 86_400 },
    { dimension: "ip", limit: 30, windowSeconds: 3_600 },
  ])
  async ageGateRoute(
    @Req() req: ApiRequest,
    @Body(new ZodPipe(AgeGateSchema)) body: z.infer<typeof AgeGateSchema>,
  ) {
    const attestation = attestationFrom(req);
    const attestedDeviceKey = await this.ageGate.resolveDevice(attestation);
    if (attestedDeviceKey === null) throw attestationProblem();
    const result = await this.ageGate.submit({
      dob: body.dob,
      deviceIdHash: body.device_id_hash,
      attestedDeviceKey,
    });
    switch (result.kind) {
      case "passed":
        return { status: "passed", expires_at: iso(result.expiresAtMs) };
      case "blocked":
        throw ageBlockedProblem(result.blockedUntilMs);
      case "invalid_dob":
        throw new ProblemError(422, "invalid-dob", "The date of birth is not valid", { code: "invalid_dob" });
    }
  }

  // ---- Apple and Google -----------------------------------------------------------------

  @Post("auth/apple")
  @HttpCode(200)
  @Public()
  @RateLimit([{ dimension: "ip", limit: 30, windowSeconds: 3_600 }])
  async apple(@Req() req: ApiRequest, @Body(new ZodPipe(SocialLoginSchema)) body: z.infer<typeof SocialLoginSchema>) {
    return this.socialLogin("apple", req, body);
  }

  @Post("auth/google")
  @HttpCode(200)
  @Public()
  @RateLimit([{ dimension: "ip", limit: 30, windowSeconds: 3_600 }])
  async google(@Req() req: ApiRequest, @Body(new ZodPipe(SocialLoginSchema)) body: z.infer<typeof SocialLoginSchema>) {
    return this.socialLogin("google", req, body);
  }

  private async socialLogin(provider: "apple" | "google", req: ApiRequest, body: z.infer<typeof SocialLoginSchema>) {
    const result = await this.social.execute({
      provider,
      idToken: body.id_token,
      nonce: body.nonce,
      installId: body.device.install_id,
      platform: body.device.platform,
      language: toLanguage(body.locale ?? DEFAULT_LOCALE),
      attestation: attestationFrom(req, body.device.platform),
    });
    switch (result.kind) {
      case "ok":
        return tokenPair(result);
      case "attestation_failed":
        throw attestationProblem();
      case "age_gate_required":
        throw ageGateRequiredProblem();
      case "age_blocked":
        throw ageBlockedProblem(result.blockedUntilMs);
      case "rejected":
        throw socialProblem(result.reason);
    }
  }

  // ---- Passkeys -------------------------------------------------------------------------

  @Post("auth/passkey/register/options")
  @HttpCode(200)
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 60 }])
  async registerOptions(@Req() req: ApiRequest) {
    const userId = req.principal?.actor.id;
    if (userId === undefined) throw Problems.unauthenticated();
    const o = await this.passkeys.issueChallenge("register", userId);
    return { challenge_id: o.challengeId, challenge: o.challenge, rp_id: o.rpId, expires_at: iso(o.expiresAtMs) };
  }

  @Post("auth/passkey/register")
  @HttpCode(204)
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 60 }])
  async registerPasskey(
    @Req() req: ApiRequest,
    @Body(new ZodPipe(PasskeyRegisterSchema)) body: z.infer<typeof PasskeyRegisterSchema>,
  ): Promise<void> {
    const userId = req.principal?.actor.id;
    if (userId === undefined) throw Problems.unauthenticated();
    const r = await this.passkeys.register({ userId, challengeId: body.challenge_id, response: body.credential });
    switch (r.kind) {
      case "registered":
        return;
      case "not_found":
        throw Problems.notFound();
      case "challenge_invalid":
        throw new ProblemError(422, "invalid-challenge", "The challenge is unknown, expired or already used", {
          code: "invalid_challenge",
        });
      case "already_registered":
        throw new ProblemError(409, "credential-exists", "This passkey is already registered", {
          code: "credential_exists",
        });
      case "rejected":
        throw new ProblemError(422, "passkey-rejected", "The passkey response was rejected", { code: "passkey_rejected" });
    }
  }

  @Post("auth/passkey/assert/options")
  @HttpCode(200)
  @Public()
  @RateLimit([{ dimension: "ip", limit: 60, windowSeconds: 3_600 }])
  async assertOptions() {
    const o = await this.passkeys.issueChallenge("assert", null);
    return { challenge_id: o.challengeId, challenge: o.challenge, rp_id: o.rpId, expires_at: iso(o.expiresAtMs) };
  }

  @Post("auth/passkey/assert")
  @HttpCode(200)
  @Public()
  @RateLimit([
    { dimension: "challenge", limit: 5, windowSeconds: 300 },
    { dimension: "ip", limit: 30, windowSeconds: 3_600 },
  ])
  async assertPasskey(
    @Req() req: ApiRequest,
    @Body(new ZodPipe(PasskeyAssertSchema)) body: z.infer<typeof PasskeyAssertSchema>,
  ) {
    const r = await this.passkeys.assert({
      challengeId: body.challenge_id,
      credentialId: body.credential.id,
      response: body.credential,
      installId: body.device.platform === "web" ? null : body.device.install_id,
      platform: body.device.platform,
      attestation: body.device.platform === "web" ? null : attestationFrom(req, body.device.platform),
    });
    switch (r.kind) {
      case "web_sign_in_not_allowed":
        throw new ProblemError(403, "web-sign-in-not-allowed", "Web sign-in is not available for this account", {
          code: "web_sign_in_not_allowed",
        });
      case "ok":
        return tokenPair(r);
      case "attestation_failed":
        throw attestationProblem();
      case "age_gate_required":
        throw ageGateRequiredProblem();
      case "age_blocked":
        throw ageBlockedProblem(r.blockedUntilMs);
      case "rejected":
        throw new ProblemError(401, "invalid-passkey-assertion", "The passkey assertion was rejected", {
          code: "invalid_passkey_assertion",
        });
    }
  }

  // ---- Refresh, logout, sessions ----------------------------------------------------------

  @Post("auth/refresh")
  @HttpCode(200)
  @Public()
  // Deliberately not @Idempotent: a stored replay would persist a token pair for 24h.
  @RateLimit([
    { dimension: "device", limit: 30, windowSeconds: 3_600 },
    { dimension: "ip", limit: 120, windowSeconds: 3_600 },
  ])
  async refreshRoute(@Req() req: ApiRequest, @Body(new ZodPipe(RefreshSchema)) body: z.infer<typeof RefreshSchema>) {
    const r = await this.refresh.execute({
      refreshToken: body.refresh_token,
      installId: body.device_install_id ?? null,
      adminInstallToken: headerValue(req, "x-admin-install") ?? null,
    });
    switch (r.kind) {
      case "ok":
        return tokenPair(r);
      case "conflict":
        throw new ProblemError(409, "refresh-conflict", "Another refresh for this session is in progress", {
          code: "refresh_conflict",
          headers: { "Retry-After": "1" },
        });
      case "invalid": {
        // Seller refresh tokens share this endpoint: the token itself decides the audience.
        if (body.device_install_id === undefined) throw invalidRefresh();
        const sr = await this.sellerRefresh.execute({ refreshToken: body.refresh_token, installId: body.device_install_id });
        if (sr.kind === "ok") return sellerSessionBody(sr);
        if (sr.kind === "conflict") {
          throw new ProblemError(409, "refresh-conflict", "Another refresh for this session is in progress", { code: "refresh_conflict", headers: { "Retry-After": "1" } });
        }
        throw invalidRefresh();
      }
    }
  }

  @Post("auth/logout")
  @HttpCode(204)
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async logout(@Req() req: ApiRequest): Promise<void> {
    const sid = req.principal?.claims.sid;
    if (sid === undefined) throw Problems.unauthenticated();
    // Idempotent for the client: an already revoked session still answers 204.
    await this.revoke.execute(sid, "logout");
  }

  @Get("me/sessions")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async list(@Req() req: ApiRequest, @Query(new ZodPipe(SessionListQuerySchema, "/query")) _query: z.infer<typeof SessionListQuerySchema>) {
    const userId = req.principal?.actor.id;
    if (userId === undefined) throw Problems.unauthenticated();
    const rows = await this.listSessions.execute(userId);
    return {
      items: rows.map((s) => ({
        id: s.session.id,
        platform: s.platform,
        created_at: iso(s.session.createdAtMs),
        last_seen_at: iso(s.session.lastUsedAtMs),
        current: req.principal?.claims.sid === s.session.id,
      })),
      // Sessions per user are few (one per device), so one page always holds them all.
      page: { next_cursor: null, has_more: false },
    };
  }
}
