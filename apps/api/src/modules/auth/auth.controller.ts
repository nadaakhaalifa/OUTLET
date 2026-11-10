import { createHmac } from "node:crypto";
import { Controller, Delete, Get, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import type { IssuedSession } from "@outlet/auth-core";
import { z } from "zod";
import { ACTIONS } from "../../platform/actions.js";
import { Authorize, Contract, NoIdempotency, Paginated, Public, RateLimit } from "../../platform/decorators.js";
import { API_DEPS } from "../../platform/deps.js";
import type { ApiDeps } from "../../platform/deps.js";
import { headerValue } from "../../platform/http.js";
import type { ApiReply, ApiRequest, RequestState } from "../../platform/http.js";
import { decodeCursor, encodeCursor } from "../../platform/cursor.js";
import { CursorQuery } from "../../platform/pagination.js";
import { Problems } from "../../platform/problem.js";
import { RATE_BUDGETS, } from "../../platform/rate-limit/budgets.js";
import { self } from "../../platform/resolvers.js";
import { Body, Ctx, Params, Query } from "../../platform/validation.js";
import {
  AssertionCredential, DeviceRegisterBody, DeviceRegistered, FederatedBody, OtpChallenge, OtpRequestBody, OtpVerifyBody, PasskeyAssertVerifyBody, PasskeyCredential, PasskeyOptions,
  PasskeyId, PasskeyOptionsBody, PasskeyPage, PasskeyRegisterVerifyBody, RefreshBody, SessionFamilyPage, SessionId, TokenPair,
} from "./dto.js";
import type { AuthServices } from "./ports.js";

/** Seconds a client should wait before asking for another code (the server's real limits are 3 per 15 min per phone, 10 per day per device). */
export const OTP_RESEND_AFTER_S = 60;
export const REFRESH_COOKIE = "__Secure-outlet_rt";

const marketOf = (s: RequestState): string => {
  if (s.marketId === undefined) throw Problems.notFound("unknown-market");
  return s.marketId;
};

/** X-Device-Id is validated (UUID) by the rate-limit guard of every route that calls this. */
const deviceOf = (req: ApiRequest): string => {
  const d = headerValue(req, "x-device-id");
  if (d === undefined) throw Problems.badRequest("device-id-required");
  return d.toLowerCase();
};

const cookieOf = (req: ApiRequest, name: string): string | undefined => {
  for (const part of (headerValue(req, "cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
};

const iso = (d: Date): string => d.toISOString();

/** Device-bound refresh cookie: HttpOnly, Secure, SameSite=Strict, scoped to the auth routes of this market. */
const refreshCookie = (market: string, token: string, expires: Date, now: Date): string =>
  `${REFRESH_COOKIE}=${token}; Max-Age=${String(Math.max(0, Math.floor((expires.getTime() - now.getTime()) / 1000)))}; Path=/v1/${market}/auth; HttpOnly; Secure; SameSite=Strict`;
const clearedCookie = (market: string): string => `${REFRESH_COOKIE}=; Max-Age=0; Path=/v1/${market}/auth; HttpOnly; Secure; SameSite=Strict`;

const pair = (s: IssuedSession, amr: readonly string[], userId: string, isNew: boolean): TokenPair => ({
  access_token: s.accessToken,
  access_expires_at: iso(s.accessExpiresAt),
  refresh_token: s.refreshToken,
  refresh_expires_at: iso(s.refreshExpiresAt),
  token_type: "Bearer",
  amr: [...amr],
  user_id: userId,
  is_new_user: isNew,
});

const passkeyDto = (c: { id: string; aaguid: string | null; transports: readonly string[]; backupEligible: boolean; createdAt: Date; lastUsedAt: Date | null }): z.infer<typeof PasskeyCredential> => ({
  id: c.id, aaguid: c.aaguid, transports: [...c.transports], backup_eligible: c.backupEligible, created_at: iso(c.createdAt), last_used_at: c.lastUsedAt === null ? null : iso(c.lastUsedAt),
});

/** Authentication: devices, OTP, refresh rotation, logout, sessions, passkeys and (fail-closed) Apple/Google. */
@Controller("v1/:market")
export class AuthController {
  constructor(@Inject(API_DEPS) private readonly deps: ApiDeps) {}

  private svc(s: RequestState): AuthServices {
    return this.deps.auth(marketOf(s));
  }

  private async issueSession(s: RequestState, req: ApiRequest, reply: ApiReply, userId: string, amr: "otp" | "passkey", isNew: boolean): Promise<TokenPair> {
    const now = this.deps.clock.now();
    let issued: IssuedSession;
    try {
      issued = await this.svc(s).sessions.issue(userId, deviceOf(req), { amr: [amr], now });
    } catch (e) {
      // The device id is a foreign key of the session family: an unregistered one is a client error, not a 500.
      if (typeof e === "object" && e !== null && "code" in e && e.code === "23503") throw Problems.badRequest("invalid-device");
      throw e;
    }
    void reply.header("set-cookie", refreshCookie(s.market?.id ?? "", issued.refreshToken, issued.refreshExpiresAt, now));
    return pair(issued, [amr], userId, isNew);
  }

  @Post("auth/devices")
  @HttpCode(201)
  @Public()
  @NoIdempotency("registering a device is idempotent on the install id (the same install returns the same device id)")
  @RateLimit({ budget: RATE_BUDGETS.deviceRegister })
  @Contract({
    operationId: "registerDevice",
    summary: "Register an install and get its device id (pre-auth, attested; budget per IP and ASN; the id goes in X-Device-Id)",
    tags: ["Auth"],
    body: DeviceRegisterBody,
    response: DeviceRegistered,
    status: 201,
    maxQueries: 0,
  })
  async registerDevice(@Ctx() s: RequestState, @Body() b: z.infer<typeof DeviceRegisterBody>): Promise<z.infer<typeof DeviceRegistered>> {
    // Proof of a genuine install first (Turnstile / App Attest); an unconfigured verifier answers 503 (fail closed).
    if (!(await this.svc(s).attestation.verify({ platform: b.platform, installId: b.install_id, token: b.attestation }))) throw Problems.forbidden("attestation-failed");
    return { device_id: await this.svc(s).devices.register({ platform: b.platform, installId: b.install_id, now: this.deps.clock.now() }) };
  }

  @Post("auth/otp/request")
  @HttpCode(201)
  @Public()
  @RateLimit({ budget: RATE_BUDGETS.otpRequestDevice })
  @Contract({
    operationId: "requestOtp",
    summary: "Send a one-time code (Egypt numbers only; 3 per 15 min per phone, 10 per day per device)",
    tags: ["Auth"],
    body: OtpRequestBody,
    response: OtpChallenge,
    status: 201,
    maxQueries: 2,
  })
  async requestOtp(@Ctx() s: RequestState, @Req() req: ApiRequest, @Body() b: z.infer<typeof OtpRequestBody>): Promise<z.infer<typeof OtpChallenge>> {
    // Only SMS is wired: a WhatsApp request is refused rather than silently sent by SMS.
    if (b.channel !== "sms") throw Problems.unprocessable("channel-unsupported");
    const r = await this.svc(s).otp.request({
      phoneE164: b.phone_e164,
      deviceId: deviceOf(req),
      marketId: marketOf(s),
      now: this.deps.clock.now(),
      purpose: b.purpose === "step_up" ? "step_up" : "login",
    });
    return { challenge_id: r.challengeId, expires_at: iso(r.expiresAt), resend_after_s: OTP_RESEND_AFTER_S, channel: "sms" };
  }

  @Post("auth/otp/verify")
  @HttpCode(200)
  @Public()
  @RateLimit({ budget: RATE_BUDGETS.otpVerify })
  @Contract({
    operationId: "verifyOtp",
    summary: "Verify the code (5 attempts per code); returns the token pair and sets the HttpOnly refresh cookie",
    tags: ["Auth"],
    body: OtpVerifyBody,
    response: TokenPair, sensitiveResponse: true,
    status: 200,
    maxQueries: 2,
  })
  async verifyOtp(@Ctx() s: RequestState, @Req() req: ApiRequest, @Res({ passthrough: true }) reply: ApiReply, @Body() b: z.infer<typeof OtpVerifyBody>): Promise<TokenPair> {
    await this.phoneVerifyBudget(marketOf(s), b.phone_e164);
    const user = await this.svc(s).otp.verify({
      challengeId: b.challenge_id,
      marketId: marketOf(s),
      phoneE164: b.phone_e164,
      code: b.code,
      deviceId: deviceOf(req),
      ...(b.dob === undefined ? {} : { dob: b.dob }),
      now: this.deps.clock.now(),
    });
    return this.issueSession(s, req, reply, user.userId, "otp", user.isNew);
  }

  /** Verify attempts per phone across challenges and devices (HMAC of market + phone: the number never reaches the limiter). */
  private async phoneVerifyBudget(market: string, phone: string): Promise<void> {
    const bud = RATE_BUDGETS.otpVerifyPhone;
    const key = createHmac("sha256", this.deps.http.rateLimitKeySecret).update(`${market}:${phone}`).digest("base64url").slice(0, 22);
    let d;
    try {
      d = await this.deps.rateLimiter.hit(`${bud.name}:phone:${key}`, { limit: bud.limit, periodMs: bud.periodMs });
    } catch {
      throw Problems.unavailable("rate-limiter-unavailable");
    }
    if (!d.allowed) throw Problems.rateLimited(d.retryAfterMs / 1000);
  }

  @Post("auth/refresh")
  @HttpCode(200)
  @Public()
  @RateLimit({ budget: RATE_BUDGETS.authRefresh })
  @Contract({
    operationId: "refreshSession",
    summary: "Rotate the refresh token (body or cookie). Reuse revokes the whole family and answers 401",
    tags: ["Auth"],
    body: RefreshBody,
    response: TokenPair, sensitiveResponse: true,
    status: 200,
    maxQueries: 2,
  })
  async refresh(@Ctx() s: RequestState, @Req() req: ApiRequest, @Res({ passthrough: true }) reply: ApiReply, @Body() b: z.infer<typeof RefreshBody>): Promise<TokenPair> {
    const token = b.refresh_token ?? cookieOf(req, REFRESH_COOKIE);
    if (token === undefined || token.length === 0 || token.length > 500) throw Problems.unauthenticated("refresh-rejected");
    const now = this.deps.clock.now();
    const out = await this.svc(s).sessions.refresh(token, deviceOf(req), now);
    void reply.header("set-cookie", refreshCookie(s.market?.id ?? "", out.refreshToken, out.refreshExpiresAt, now));
    const claims = await this.deps.tokens.verify(out.accessToken, marketOf(s), now);
    return pair(out, claims.amr, claims.userId, false);
  }

  @Post("auth/logout")
  @HttpCode(204)
  @Authorize(ACTIONS.sessionWrite, self)
  @RateLimit({ budget: RATE_BUDGETS.shopperWrite })
  @Contract({
    operationId: "logout",
    summary: "Revoke the current session family (idempotent) and clear the refresh cookie",
    tags: ["Auth"],
    body: z.strictObject({}),
    response: z.undefined(),
    status: 204,
    maxQueries: 2,
  })
  async logout(@Ctx() s: RequestState, @Res({ passthrough: true }) reply: ApiReply): Promise<undefined> {
    const user = s.user;
    if (user === undefined) throw Problems.unauthenticated();
    await this.svc(s).sessions.revoke(user.sessionId, user.userId, this.deps.clock.now());
    void reply.header("set-cookie", clearedCookie(s.market?.id ?? ""));
    return undefined;
  }

  @Post("auth/logout-by-refresh")
  @HttpCode(204)
  @Public()
  @NoIdempotency("revoking a session family is idempotent; no response body to replay")
  @RateLimit({ budget: RATE_BUDGETS.authLogout })
  @Contract({
    operationId: "logoutByRefresh",
    summary: "Sign out with the refresh token (body or cookie) when the access token has expired; always 204, clears the cookie",
    tags: ["Auth"],
    body: RefreshBody,
    response: z.undefined(),
    status: 204,
    maxQueries: 2,
  })
  async logoutByRefresh(@Ctx() s: RequestState, @Req() req: ApiRequest, @Res({ passthrough: true }) reply: ApiReply, @Body() b: z.infer<typeof RefreshBody>): Promise<undefined> {
    const token = b.refresh_token ?? cookieOf(req, REFRESH_COOKIE);
    // An unknown, malformed or already-revoked token looks the same as a known one: no oracle.
    if (token !== undefined && token.length > 0 && token.length <= 500) await this.svc(s).sessions.revokeByRefreshToken(token, deviceOf(req), this.deps.clock.now());
    void reply.header("set-cookie", clearedCookie(s.market?.id ?? ""));
    return undefined;
  }

  @Get("me/sessions")
  @Paginated()
  @Authorize(ACTIONS.sessionRead, self)
  @RateLimit({ budget: RATE_BUDGETS.shopperRead })
  @Contract({
    operationId: "listMySessions",
    summary: "My signed-in devices (no IP, no raw user agent)",
    tags: ["Auth"],
    query: CursorQuery,
    response: SessionFamilyPage,
    maxQueries: 1,
  })
  async listSessions(@Ctx() s: RequestState, @Query() q: CursorQuery): Promise<SessionFamilyPage> {
    const user = s.user;
    if (user === undefined) throw Problems.unauthenticated();
    const page = await this.svc(s).sessionReader.list(user.userId, { limit: q.limit, ...(q.cursor === undefined ? {} : { cursor: q.cursor }) });
    return {
      items: page.items.map((r) => ({
        id: r.id,
        device_id: r.deviceId,
        platform: r.platform,
        ua_family: r.uaFamily,
        amr: [...r.amr],
        created_at: iso(r.createdAt),
        last_seen_at: r.lastSeenAt === null ? null : iso(r.lastSeenAt),
        current: r.id === user.sessionId,
      })),
      next_cursor: page.nextCursor,
    };
  }

  @Delete("me/sessions/:session_family_id")
  @HttpCode(204)
  @Authorize(ACTIONS.sessionWrite, self)
  @RateLimit({ budget: RATE_BUDGETS.shopperWrite })
  @Contract({
    operationId: "revokeMySession",
    summary: "Sign out one of my devices (another user's session is 404)",
    tags: ["Auth"],
    params: SessionId,
    response: z.undefined(),
    status: 204,
    maxQueries: 2,
  })
  async revokeSession(@Ctx() s: RequestState, @Params() p: z.infer<typeof SessionId>): Promise<undefined> {
    const user = s.user;
    if (user === undefined) throw Problems.unauthenticated();
    // revoke() is scoped to the owner in SQL: a foreign or unknown id changes nothing and is reported as 404.
    if (!(await this.svc(s).sessions.revoke(p.session_family_id, user.userId, this.deps.clock.now()))) throw Problems.notFound();
    return undefined;
  }

  // ------------------------------------------------------------------ federated sign-in (fail closed)
  @Post("auth/apple")
  @HttpCode(200)
  @Public()
  @RateLimit({ budget: RATE_BUDGETS.federatedSignIn })
  @Contract({ operationId: "signInWithApple", summary: "Sign in with Apple (503 until the OIDC verifier and identity linking are configured)", tags: ["Auth"], body: FederatedBody, response: TokenPair, sensitiveResponse: true, status: 200, maxQueries: 2 })
  signInWithApple(): Promise<TokenPair> {
    return this.federated();
  }

  @Post("auth/google")
  @HttpCode(200)
  @Public()
  @RateLimit({ budget: RATE_BUDGETS.federatedSignIn })
  @Contract({ operationId: "signInWithGoogle", summary: "Sign in with Google (503 until the OIDC verifier and identity linking are configured)", tags: ["Auth"], body: FederatedBody, response: TokenPair, sensitiveResponse: true, status: 200, maxQueries: 2 })
  signInWithGoogle(): Promise<TokenPair> {
    return this.federated();
  }

  /**
   * No OIDC verifier is configured (provider contracts, ADR-0029) and `user_identities` linking is not built: refuse before
   * looking at the token. Documented in docs/adr/0012-http-layer.md (decision log).
   */
  private federated(): Promise<TokenPair> {
    return Promise.reject(Problems.unavailable("oidc-unavailable"));
  }

  // ------------------------------------------------------------------ passkeys
  @Post("auth/passkeys/register/options")
  @HttpCode(200)
  @Authorize(ACTIONS.passkeyWrite, self)
  @RateLimit({ budget: RATE_BUDGETS.passkeyRegister })
  @Contract({
    operationId: "passkeyRegisterOptions",
    summary: "WebAuthn creation options for the signed-in user (discoverable credential, user verification required)",
    tags: ["Auth"],
    body: PasskeyOptionsBody,
    response: PasskeyOptions,
    status: 200,
    maxQueries: 2,
  })
  async registerOptions(@Ctx() s: RequestState, @Req() req: ApiRequest, @Body() b: z.infer<typeof PasskeyOptionsBody>): Promise<z.infer<typeof PasskeyOptions>> {
    const user = s.user;
    if (user === undefined) throw Problems.unauthenticated();
    if (b.purpose !== "register") throw Problems.unprocessable("purpose-invalid");
    const o = await this.svc(s).passkeys.registrationOptions({ userId: user.userId, deviceId: this.deviceOrNone(req), now: this.deps.clock.now() });
    return { challenge_id: o.challengeId, public_key: o.publicKey, expires_at: iso(o.expiresAt) };
  }

  @Post("auth/passkeys/register/verify")
  @HttpCode(201)
  @Authorize(ACTIONS.passkeyWrite, self)
  @RateLimit({ budget: RATE_BUDGETS.passkeyRegister })
  @Contract({
    operationId: "passkeyRegisterVerify",
    summary: "Finish enrolment: verifies the attestation and stores the credential (the strong-auth gate for seller and admin accounts)",
    tags: ["Auth"],
    body: PasskeyRegisterVerifyBody,
    response: PasskeyCredential,
    status: 201,
    maxQueries: 2,
  })
  async registerVerify(@Ctx() s: RequestState, @Req() req: ApiRequest, @Body() b: z.infer<typeof PasskeyRegisterVerifyBody>): Promise<z.infer<typeof PasskeyCredential>> {
    const user = s.user;
    if (user === undefined) throw Problems.unauthenticated();
    const c = await this.svc(s).passkeys.verifyRegistration({
      userId: user.userId,
      deviceId: this.deviceOrNone(req),
      challengeId: b.challenge_id,
      credential: b.credential,
      now: this.deps.clock.now(),
    });
    return passkeyDto(c);
  }

  @Get("me/passkeys")
  @Paginated()
  @Authorize(ACTIONS.passkeyRead, self)
  @RateLimit({ budget: RATE_BUDGETS.shopperRead })
  @Contract({ operationId: "listMyPasskeys", summary: "My registered passkeys (no key material)", tags: ["Auth"], query: CursorQuery, response: PasskeyPage, maxQueries: 1 })
  async listPasskeys(@Ctx() s: RequestState, @Query() q: CursorQuery): Promise<PasskeyPage> {
    const user = s.user;
    if (user === undefined) throw Problems.unauthenticated();
    const all = await this.svc(s).passkeys.list(user.userId);
    const from = q.cursor === undefined ? 0 : Number(decodeCursor(q.cursor, 1)[0]);
    const items = all.slice(from, from + q.limit);
    const next = from + q.limit;
    return { items: items.map(passkeyDto), next_cursor: next < all.length ? encodeCursor(String(next)) : null };
  }

  @Delete("me/passkeys/:passkey_id")
  @HttpCode(204)
  @Authorize(ACTIONS.passkeyWrite, self)
  @RateLimit({ budget: RATE_BUDGETS.shopperWrite })
  @Contract({ operationId: "revokeMyPasskey", summary: "Revoke one of my passkeys (another user's passkey is 404)", tags: ["Auth"], params: PasskeyId, response: z.undefined(), status: 204, maxQueries: 2 })
  async revokePasskey(@Ctx() s: RequestState, @Params() p: z.infer<typeof PasskeyId>): Promise<undefined> {
    const user = s.user;
    if (user === undefined) throw Problems.unauthenticated();
    if (!(await this.svc(s).passkeys.revoke(user.userId, p.passkey_id, this.deps.clock.now()))) throw Problems.notFound();
    return undefined;
  }

  @Post("auth/passkeys/assert/options")
  @HttpCode(200)
  @Public()
  @RateLimit({ budget: RATE_BUDGETS.passkeyAssertOptions })
  @Contract({
    operationId: "passkeyAssertOptions",
    summary: "WebAuthn request options (usernameless sign-in)",
    tags: ["Auth"],
    body: PasskeyOptionsBody,
    response: PasskeyOptions,
    status: 200,
    maxQueries: 2,
  })
  async assertOptions(@Ctx() s: RequestState, @Req() req: ApiRequest, @Body() b: z.infer<typeof PasskeyOptionsBody>): Promise<z.infer<typeof PasskeyOptions>> {
    if (b.purpose === "register") throw Problems.unprocessable("purpose-invalid");
    const o = await this.svc(s).passkeys.assertionOptions({ deviceId: deviceOf(req), now: this.deps.clock.now() });
    return { challenge_id: o.challengeId, public_key: o.publicKey, expires_at: iso(o.expiresAt) };
  }

  @Post("auth/passkeys/assert/verify")
  @HttpCode(200)
  @Public()
  @RateLimit({ budget: RATE_BUDGETS.passkeyAssertVerify })
  @Contract({
    operationId: "passkeyAssertVerify",
    summary: "Verify the assertion and sign in with amr passkey (sets the HttpOnly refresh cookie)",
    tags: ["Auth"],
    body: PasskeyAssertVerifyBody,
    response: TokenPair, sensitiveResponse: true,
    status: 200,
    maxQueries: 2,
  })
  async assertVerify(@Ctx() s: RequestState, @Req() req: ApiRequest, @Res({ passthrough: true }) reply: ApiReply, @Body() b: z.infer<typeof PasskeyAssertVerifyBody>): Promise<TokenPair> {
    const c: z.infer<typeof AssertionCredential> = b.credential;
    const r = await this.svc(s).passkeys.verifyAssertion({
      credentialId: c.id,
      clientDataJSON: c.response.clientDataJSON,
      authenticatorData: c.response.authenticatorData,
      signature: c.response.signature,
      challengeId: b.challenge_id,
      deviceId: deviceOf(req),
    });
    return this.issueSession(s, req, reply, r.userId, "passkey", false);
  }

  /** Registration is authenticated, so a device header is optional there: the challenge is bound to the user. */
  private deviceOrNone(req: ApiRequest): string {
    return headerValue(req, "x-device-id")?.toLowerCase() ?? "none";
  }
}
