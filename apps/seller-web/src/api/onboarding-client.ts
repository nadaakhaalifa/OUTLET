import type { z } from "zod";
import { err, ok, type Result } from "../lib/result";
import type { ApiError, ApiErrorKind, ApiOk } from "./client";
import * as O from "./schemas-onboarding";
import { problemSchema } from "./schemas";
import { NetworkError, type Transport, type TransportRequest } from "./transport";

/**
 * Typed client for seller auth, brand onboarding and store settings. Zod parses every response (API10).
 * Bearer tokens come from a TokenSource so the same client serves the enrol token and the full session.
 */
export interface TokenSource {
  bearer(): Promise<string | null>;
  /** Called once after a 401. Return true when a new bearer is available. */
  refresh(): Promise<boolean>;
}

export interface OnboardingDeps {
  readonly transport: Transport;
  readonly tokens: TokenSource;
  readonly newIdempotencyKey: () => string;
}

export type OnboardingOk<T> = ApiOk<T> & { readonly etag: string | null };
export type OnboardingResult<T> = Result<OnboardingOk<T>, ApiError>;

/** Optional per-call write options: a caller-supplied idempotency key makes a double submit a replay. */
export interface WriteOptions {
  readonly idempotencyKey?: string;
  readonly ifMatch?: string;
}

const kindFor = (status: number): ApiErrorKind => {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409 || status === 412) return "conflict";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 422) return "validation";
  return "server";
};

const parseDate = (h: string | undefined): number | null => {
  if (h === undefined) return null;
  const t = Date.parse(h);
  return Number.isNaN(t) ? null : t;
};

type Auth = "none" | "bearer";

export function createOnboardingApi(deps: OnboardingDeps) {
  async function exec(
    req: TransportRequest, auth: Auth, write: boolean, opts: WriteOptions = {}, retried = false,
  ): Promise<Result<{ json?: unknown; serverNowMs: number | null; etag: string | null }, ApiError>> {
    const headers: Record<string, string> = { ...req.headers };
    if (auth === "bearer") {
      const bearer = await deps.tokens.bearer();
      if (bearer === null) return err({ kind: "unauthorized", status: 401 });
      headers.authorization = `Bearer ${bearer}`;
    }
    if (write) headers["idempotency-key"] = opts.idempotencyKey ?? deps.newIdempotencyKey();
    if (opts.ifMatch !== undefined) headers["if-match"] = opts.ifMatch;
    let res;
    try {
      res = await deps.transport.send({ ...req, headers });
    } catch (e) {
      if (e instanceof NetworkError) return err({ kind: "offline" });
      throw e;
    }
    if (res.status === 401 && auth === "bearer" && !retried) {
      if (await deps.tokens.refresh()) return exec(req, auth, write, { ...opts, ...(headers["idempotency-key"] === undefined ? {} : { idempotencyKey: headers["idempotency-key"] }) }, true);
      return err({ kind: "unauthorized", status: 401 });
    }
    if (res.status >= 200 && res.status < 300) {
      return ok({ ...(res.json === undefined ? {} : { json: res.json }), serverNowMs: parseDate(res.headers.date), etag: res.headers.etag ?? null });
    }
    const p = problemSchema.safeParse(res.json);
    const base: ApiError = { kind: kindFor(res.status), status: res.status };
    if (!p.success) return err(base);
    return err({
      ...base,
      ...(p.data.code === undefined ? {} : { code: p.data.code }),
      ...(p.data.request_id === undefined ? {} : { requestId: p.data.request_id }),
      ...(p.data.errors === undefined ? {} : { violations: p.data.errors.map((v) => ({ pointer: v.pointer, code: v.code })) }),
    });
  }

  async function call<T extends z.ZodType>(
    schema: T, req: TransportRequest, auth: Auth, write = false, opts: WriteOptions = {},
  ): Promise<OnboardingResult<z.output<T>>> {
    const r = await exec(req, auth, write, opts);
    if (!r.ok) return r;
    const parsed = schema.safeParse(r.value.json);
    if (!parsed.success) return err({ kind: "contract", status: 200 });
    return ok({ data: parsed.data as z.output<T>, serverNowMs: r.value.serverNowMs, etag: r.value.etag });
  }

  async function noContent(req: TransportRequest, opts: WriteOptions = {}): Promise<OnboardingResult<null>> {
    const r = await exec(req, "bearer", true, opts);
    if (!r.ok) return r;
    return ok({ data: null, serverNowMs: r.value.serverNowMs, etag: r.value.etag });
  }

  const e = encodeURIComponent;
  const store = (id: string): string => `/v1/seller/stores/${e(id)}`;
  const app = (id: string): string => `/v1/seller/applications/${e(id)}`;

  return {
    /* ---- auth ---- */
    requestOtp: (body: { phone_e164: string; email: string; locale: "ar" | "en"; channel?: "sms" | "whatsapp" }, o?: WriteOptions) =>
      call(O.otpChallenge, { method: "POST", path: "/v1/seller/auth/otp/request", body }, "none", true, o),
    verifyOtp: (body: { challenge_id: string; code: string }, o?: WriteOptions) =>
      call(O.otpVerified, { method: "POST", path: "/v1/seller/auth/otp/verify", body }, "none", true, o),
    passkeyRegisterOptions: () =>
      call(O.webauthnOptions, { method: "POST", path: "/v1/seller/auth/passkey/register/options", body: {} }, "bearer", true),
    passkeyRegister: (body: { challenge_id: string; credential: Record<string, unknown>; label?: string }, o?: WriteOptions) =>
      call(O.sellerSessionTokens, { method: "POST", path: "/v1/seller/auth/passkey/register", body }, "bearer", true, o),
    totpEnrol: () => call(O.totpEnrol, { method: "POST", path: "/v1/seller/auth/totp/enrol", body: {} }, "bearer", true),
    totpConfirm: (code: string, o?: WriteOptions) =>
      call(O.sellerSessionTokens, { method: "POST", path: "/v1/seller/auth/totp/confirm", body: { code } }, "bearer", true, o),
    passkeyAssertOptions: (otpProof: string) =>
      call(O.webauthnOptions, { method: "POST", path: "/v1/seller/auth/passkey/assert/options", body: { otp_proof: otpProof } }, "none", false),
    passkeyAssert: (body: { challenge_id: string; credential: Record<string, unknown> }) =>
      call(O.sellerSessionTokens, { method: "POST", path: "/v1/seller/auth/passkey/assert", body }, "none", false),
    totpAssert: (body: { otp_proof: string; code: string }) =>
      call(O.sellerSessionTokens, { method: "POST", path: "/v1/seller/auth/totp/assert", body }, "none", false),
    me: () => call(O.sellerMe, { method: "GET", path: "/v1/seller/me" }, "bearer"),

    /* ---- applications ---- */
    requirements: (kind: O.BrandKind, country: string) =>
      call(O.requirements, { method: "GET", path: "/v1/seller/applications/requirements", query: { kind, country } }, "bearer"),
    listApplications: () => call(O.applicationPage, { method: "GET", path: "/v1/seller/applications", query: { limit: 20 } }, "bearer"),
    createApplication: (body: { brand_kind: O.BrandKind; country: string; brand_name: string }, o?: WriteOptions) =>
      call(O.application, { method: "POST", path: "/v1/seller/applications", body }, "bearer", true, o),
    getApplication: (id: string) => call(O.application, { method: "GET", path: app(id) }, "bearer"),
    updateApplication: (id: string, body: O.ApplicationPatch, o?: WriteOptions) =>
      call(O.application, { method: "PATCH", path: app(id), body }, "bearer", true, o),
    submitApplication: (id: string, o?: WriteOptions) =>
      call(O.application, { method: "POST", path: `${app(id)}/submit`, body: {} }, "bearer", true, o),
    resubmitApplication: (id: string, body: { note?: string; satisfied_item_codes?: readonly string[] }, o?: WriteOptions) =>
      call(O.application, { method: "POST", path: `${app(id)}/resubmit`, body }, "bearer", true, o),
    withdrawApplication: (id: string, o?: WriteOptions) =>
      call(O.application, { method: "POST", path: `${app(id)}/withdraw`, body: {} }, "bearer", true, o),
    appealApplication: (id: string, statement: string, o?: WriteOptions) =>
      call(O.application, { method: "POST", path: `${app(id)}/appeal`, body: { statement } }, "bearer", true, o),
    createDocument: (
      id: string,
      body: { requirement_code: string; content_type: "application/pdf" | "image/jpeg" | "image/png"; size_bytes: number; sha256: string; original_filename?: string },
      o?: WriteOptions,
    ) => call(O.documentUpload, { method: "POST", path: `${app(id)}/documents`, body }, "bearer", true, o),
    confirmDocument: (id: string, documentId: string, o?: WriteOptions) =>
      call(O.applicationDocument, { method: "POST", path: `${app(id)}/documents/${e(documentId)}/confirm`, body: {} }, "bearer", true, o),
    deleteDocument: (id: string, documentId: string) => noContent({ method: "DELETE", path: `${app(id)}/documents/${e(documentId)}` }),
    startDomainVerification: (id: string, body: { method: "dns_txt" | "email"; email_local_part?: "admin" | "info" | "webmaster" | "hostmaster" }, o?: WriteOptions) =>
      call(O.domainVerification, { method: "POST", path: `${app(id)}/domain-verification`, body }, "bearer", true, o),
    confirmDomainVerification: (id: string, code?: string, o?: WriteOptions) =>
      call(O.domainVerification, { method: "POST", path: `${app(id)}/domain-verification/confirm`, body: code === undefined ? {} : { code } }, "bearer", true, o),
    checklist: () => call(O.checklist, { method: "GET", path: "/v1/seller/onboarding-checklist" }, "bearer"),

    /* ---- store settings ---- */
    profile: (storeId: string) => call(O.storeProfile, { method: "GET", path: `${store(storeId)}/profile` }, "bearer"),
    putProfile: (storeId: string, body: PutProfileBody, o?: WriteOptions) =>
      call(O.storeProfile, { method: "PUT", path: `${store(storeId)}/profile`, body }, "bearer", true, o),
    putVacation: (storeId: string, body: { enabled: boolean; until?: string | null; eta_extra_days: number }, o?: WriteOptions) =>
      call(O.storeProfile, { method: "PUT", path: `${store(storeId)}/vacation`, body }, "bearer", true, o),
    createMediaUpload: (storeId: string, body: { slot: "logo" | "cover"; content_type: string; byte_size: number }, o?: WriteOptions) =>
      call(O.mediaUpload, { method: "POST", path: `${store(storeId)}/media/uploads`, body }, "bearer", true, o),
    confirmMediaUpload: (storeId: string, uploadId: string, o?: WriteOptions) =>
      call(O.mediaConfirm, { method: "POST", path: `${store(storeId)}/media/uploads/${e(uploadId)}/confirm`, body: {} }, "bearer", true, o),
    payoutAccount: (storeId: string) => call(O.payoutAccount, { method: "GET", path: `${store(storeId)}/payout-account` }, "bearer"),
    putPayoutAccount: (storeId: string, body: { iban: string; account_holder_name: string }, o?: WriteOptions) =>
      call(O.payoutAccount, { method: "PUT", path: `${store(storeId)}/payout-account`, body }, "bearer", true, o),
    payoutHistory: (storeId: string) => call(O.payoutHistory, { method: "GET", path: `${store(storeId)}/payout-account/history` }, "bearer"),
    shipping: (storeId: string) => call(O.shippingProfile, { method: "GET", path: `${store(storeId)}/shipping` }, "bearer"),
    putShipping: (storeId: string, body: PutShippingBody, o?: WriteOptions) =>
      call(O.shippingProfile, { method: "PUT", path: `${store(storeId)}/shipping`, body }, "bearer", true, o),
    notificationPrefs: (storeId: string) => call(O.notificationPrefs, { method: "GET", path: `${store(storeId)}/notification-preferences` }, "bearer"),
    putNotificationPrefs: (storeId: string, preferences: Record<string, Record<string, boolean>>, o?: WriteOptions) =>
      call(O.notificationPrefs, { method: "PUT", path: `${store(storeId)}/notification-preferences`, body: { preferences } }, "bearer", true, o),
    team: (storeId: string) => call(O.sellerTeam, { method: "GET", path: `${store(storeId)}/team` }, "bearer"),
    invite: (storeId: string, body: { phone: string; role: O.SellerRole }, o?: WriteOptions) =>
      call(O.teamInvite, { method: "POST", path: `${store(storeId)}/team/invites`, body }, "bearer", true, o),
    revokeInvite: (storeId: string, inviteId: string, o?: WriteOptions) =>
      noContent({ method: "DELETE", path: `${store(storeId)}/team/invites/${e(inviteId)}` }, o),
    changeRole: (storeId: string, userId: string, role: O.SellerRole, o?: WriteOptions) =>
      call(O.roleChange, { method: "PATCH", path: `${store(storeId)}/team/members/${e(userId)}`, body: { role } }, "bearer", true, o),
    removeMember: (storeId: string, userId: string, o?: WriteOptions) =>
      noContent({ method: "DELETE", path: `${store(storeId)}/team/members/${e(userId)}` }, o),
    etaEnrolment: (storeId: string) => call(O.etaEnrolment, { method: "GET", path: `${store(storeId)}/eta-enrolment` }, "bearer"),
    requestEta: (storeId: string, o?: WriteOptions) =>
      call(O.etaEnrolment, { method: "POST", path: `${store(storeId)}/eta-enrolment/request`, body: {} }, "bearer", true, o),
  };
}

export type OnboardingApi = ReturnType<typeof createOnboardingApi>;

export interface PutProfileBody {
  name_ar: string;
  name_en?: string | null;
  description_ar?: string | null;
  description_en?: string | null;
  social_links: Record<string, string>;
  return_policy: { change_of_mind_days: number; defect_days: number; text_ar?: string | null; text_en?: string | null };
  free_delivery_threshold: { amount: string; currency: "EGP" };
}

export interface PutShippingBody {
  origin: {
    governorate_code: string; city_code: string; street: string; building?: string | null; landmark: string;
    contact_name: string; contact_phone: string; pin?: { lat: number; lng: number } | null;
  };
  handling_time_hours: number;
  courier_preferences: Record<string, string[]>;
  packaging_options: string[];
}
