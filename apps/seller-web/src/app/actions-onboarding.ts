"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ApiError } from "../api/client";
import type { WriteOptions } from "../api/onboarding-client";
import type { MessageKey } from "../i18n";
import { getOnboarding, readEnrol, resolveStore, writeEnrol, type StoreScope } from "../onboarding-context";
import { buildFormModel, buildPatch, DPA_VERSION, SELLER_AGREEMENT_VERSION, validateAll, validateNewApplication, providedWriteOnly, type FormValues } from "../view-models/application-form";
import { validateAppeal } from "../view-models/application-status";
import { cairoLocalToIso, profileBody, profileValues, validateInvite, validateProfile, validateShipping, validateVacation, hasVersionConflict, prefCells, prefsChanges, NOTIFICATION_EVENTS, NOTIFICATION_CHANNELS, type ProfileValues } from "../view-models/store-settings";
import { checkEgyptIban, IBAN_PROBLEM_KEY } from "../view-models/iban";
import { normalizeCode, validateSignUp, normalizePhone } from "../view-models/auth-flow";
import { sellerRole } from "../api/schemas-onboarding";
import { LOCALE_COOKIE } from "../server-context";
import { safeNextPath } from "../view-models/auth-flow";

export type Out<T = null> =
  | { readonly ok: true; readonly data: T; readonly messageKey?: MessageKey }
  | {
      readonly ok: false;
      readonly messageKey: MessageKey;
      readonly code?: string;
      readonly unauthorized?: boolean;
      readonly stepUp?: boolean;
      readonly conflict?: boolean;
      readonly fieldErrors?: Readonly<Record<string, MessageKey>>;
    };

/** useActionState shape for data-driven forms. */
export type FormOut = Out<null>;

const fail = (messageKey: MessageKey, extra: Partial<Extract<Out, { ok: false }>> = {}): Extract<Out, { ok: false }> => ({ ok: false, messageKey, ...extra });

function failFromApi(e: ApiError): Extract<Out, { ok: false }> {
  const code = e.code;
  const base = code === undefined ? {} : { code };
  switch (e.kind) {
    case "unauthorized": return fail("state.sessionExpired", { ...base, unauthorized: true });
    case "forbidden": return fail("state.forbidden", base);
    case "not_found": return fail("state.notFound", base);
    case "rate_limited": return fail("state.rateLimited", base);
    case "offline": return fail("state.offline", base);
    case "conflict": return fail(code === "version_conflict" || code === undefined ? "ob.err.conflict" : "ob.err.conflict_other", { ...base, conflict: true });
    case "validation":
      if (code === "strong_factor_required") return fail("ob.err.step_up", { ...base, stepUp: true });
      if (code === "name_mismatch") return fail("ob.err.name_mismatch", base);
      if (code === "checklist_incomplete") return fail("ob.err.checklist_incomplete", base);
      if (code === "document_pending_scan") return fail("ob.err.pending_scan", base);
      if (code === "invalid_otp" || code === "otp_invalid" || code === "invalid_code") return fail("ob.err.code_invalid", base);
      return fail("ob.err.validation", base);
    case "contract": return fail("state.contract", base);
    default: return fail("state.error", base);
  }
}

const idem = (form: FormData): WriteOptions => {
  const k = z.uuid().safeParse(form.get("idem"));
  return k.success ? { idempotencyKey: k.data } : {};
};
const fstr = (form: FormData, k: string): string => {
  const v = form.get(k);
  return typeof v === "string" ? v : "";
};

async function withStore<T>(
  fn: (api: NonNullable<Awaited<ReturnType<typeof getOnboarding>>["api"]>, scope: StoreScope) => Promise<Out<T>>,
): Promise<Out<T>> {
  const ctx = await getOnboarding();
  if (ctx.api === null) return fail("state.notConfigured");
  const s = await resolveStore(ctx.api);
  if (s.unauthorized) return fail("state.sessionExpired", { unauthorized: true });
  if (s.offline) return fail("state.offline");
  if (s.scope === null) return fail("state.forbidden");
  return fn(ctx.api, s.scope);
}

/* =============================== AUTH =============================== */
export async function requestOtpAction(input: { phone: string; email: string; locale: "ar" | "en"; channel: "sms" | "whatsapp" }): Promise<
  Out<{ challengeId: string; expiresIn: number; resendAfter: number }>
> {
  const v = validateSignUp(input.phone, input.email);
  if (v.phone === null || v.email === null) return fail("ob.err.validation", { fieldErrors: v.errors as Record<string, MessageKey> });
  const { api } = await getOnboarding();
  if (api === null) return fail("state.notConfigured");
  const r = await api.requestOtp({ phone_e164: v.phone, email: v.email, locale: input.locale, channel: input.channel });
  if (!r.ok) return failFromApi(r.error);
  return { ok: true, data: { challengeId: r.value.data.challenge_id, expiresIn: r.value.data.expires_in, resendAfter: r.value.data.resend_after } };
}

export async function verifyOtpAction(input: { challengeId: string; code: string }): Promise<Out<{ nextStep: "enrol_strong_factor" | "assert_strong_factor" }>> {
  const id = z.uuid().safeParse(input.challengeId);
  const code = normalizeCode(input.code);
  if (!id.success || code === null) return fail("ob.auth.err.code");
  const { api } = await getOnboarding();
  if (api === null) return fail("state.notConfigured");
  const r = await api.verifyOtp({ challenge_id: id.data, code });
  if (!r.ok) return failFromApi(r.error);
  await writeEnrol({ enrolToken: r.value.data.enrol_token, otpProof: r.value.data.otp_proof ?? null, nextStep: r.value.data.next_step }, r.value.data.expires_in);
  return { ok: true, data: { nextStep: r.value.data.next_step } };
}

export async function passkeyOptionsAction(mode: "register" | "assert"): Promise<Out<{ challengeId: string; publicKey: Record<string, unknown> }>> {
  const { api } = await getOnboarding();
  if (api === null) return fail("state.notConfigured");
  if (mode === "register") {
    const r = await api.passkeyRegisterOptions();
    if (!r.ok) return failFromApi(r.error);
    return { ok: true, data: { challengeId: r.value.data.challenge_id, publicKey: r.value.data.public_key } };
  }
  const enrol = await readEnrol();
  if (enrol === null || enrol.otpProof === null) return fail("state.sessionExpired", { unauthorized: true });
  const r = await api.passkeyAssertOptions(enrol.otpProof);
  if (!r.ok) return failFromApi(r.error);
  return { ok: true, data: { challengeId: r.value.data.challenge_id, publicKey: r.value.data.public_key } };
}

export async function passkeyFinishAction(input: { mode: "register" | "assert"; challengeId: string; credential: Record<string, unknown>; label?: string }): Promise<Out<{ redirect: string }>> {
  const id = z.uuid().safeParse(input.challengeId);
  if (!id.success) return fail("ob.err.validation");
  const ctx = await getOnboarding();
  if (ctx.api === null) return fail("state.notConfigured");
  const r = input.mode === "register"
    ? await ctx.api.passkeyRegister({ challenge_id: id.data, credential: input.credential, ...(input.label === undefined ? {} : { label: input.label.slice(0, 60) }) })
    : await ctx.api.passkeyAssert({ challenge_id: id.data, credential: input.credential });
  if (!r.ok) return failFromApi(r.error);
  await ctx.startSession(r.value.data);
  return { ok: true, data: { redirect: "/start" } };
}

export async function totpEnrolAction(): Promise<Out<{ otpauthUri: string; recoveryCodes: readonly string[] }>> {
  const { api } = await getOnboarding();
  if (api === null) return fail("state.notConfigured");
  const r = await api.totpEnrol();
  if (!r.ok) return failFromApi(r.error);
  return { ok: true, data: { otpauthUri: r.value.data.otpauth_uri, recoveryCodes: r.value.data.recovery_codes } };
}

export async function totpFinishAction(input: { mode: "confirm" | "assert"; code: string }): Promise<Out<{ redirect: string }>> {
  const code = normalizeCode(input.code);
  if (code === null) return fail("ob.auth.err.code");
  const ctx = await getOnboarding();
  if (ctx.api === null) return fail("state.notConfigured");
  let r;
  if (input.mode === "confirm") r = await ctx.api.totpConfirm(code);
  else {
    const enrol = await readEnrol();
    if (enrol === null || enrol.otpProof === null) return fail("state.sessionExpired", { unauthorized: true });
    r = await ctx.api.totpAssert({ otp_proof: enrol.otpProof, code });
  }
  if (!r.ok) return failFromApi(r.error);
  await ctx.startSession(r.value.data);
  return { ok: true, data: { redirect: "/start" } };
}

/* =============================== APPLICATIONS =============================== */
export async function createApplicationAction(input: { kind: "local" | "global" | null; country: string; brandName: string; idem?: string }): Promise<Out<{ id: string }>> {
  const errors = validateNewApplication(input.kind, input.country, input.brandName);
  if (Object.keys(errors).length > 0 || input.kind === null) return fail("ob.err.validation", { fieldErrors: errors });
  const { api } = await getOnboarding();
  if (api === null) return fail("state.notConfigured");
  const key = z.uuid().safeParse(input.idem);
  const r = await api.createApplication(
    { brand_kind: input.kind, country: input.country.trim().toUpperCase(), brand_name: input.brandName.trim() },
    key.success ? { idempotencyKey: key.data } : {},
  );
  if (!r.ok) return failFromApi(r.error);
  return { ok: true, data: { id: r.value.data.id } };
}

const valuesSchema = z.record(z.string().max(60), z.string().max(600));

export async function saveDetailsAction(input: { id: string; values: unknown; ifMatch?: string | null }): Promise<Out<{ etag: string | null }>> {
  const id = z.uuid().safeParse(input.id);
  const values = valuesSchema.safeParse(input.values);
  if (!id.success || !values.success) return fail("ob.err.validation");
  const { api, locale } = await getOnboarding();
  if (api === null) return fail("state.notConfigured");
  const app = await api.getApplication(id.data);
  if (!app.ok) return failFromApi(app.error);
  const req = await api.requirements(app.value.data.brand_kind, app.value.data.country);
  if (!req.ok) return failFromApi(req.error);
  const model = buildFormModel(req.value.data, locale);
  const errors = validateAll(model, values.data as FormValues, app.value.data.country, Date.now(), providedWriteOnly(app.value.data));
  // Draft saves allow incomplete forms; only malformed (non-required) values block.
  const hard: Record<string, MessageKey> = {};
  for (const [k, v] of Object.entries(errors)) if (v !== "ob.form.err.required") hard[k] = v;
  if (Object.keys(hard).length > 0) return fail("ob.err.validation", { fieldErrors: hard });
  const r = await api.updateApplication(id.data, buildPatch(model, values.data as FormValues), input.ifMatch === null || input.ifMatch === undefined ? {} : { ifMatch: input.ifMatch });
  if (!r.ok) return failFromApi(r.error);
  revalidatePath(`/apply/${id.data}`);
  return { ok: true, data: { etag: r.value.etag }, messageKey: "ob.apply.saved" };
}

export async function createDocumentAction(input: {
  id: string; requirementCode: string; contentType: string; size: number; sha256: string; filename: string;
}): Promise<Out<{ documentId: string; uploadUrl: string; headers: Record<string, string> }>> {
  const p = z.object({
    id: z.uuid(), requirementCode: z.string().min(1).max(60),
    contentType: z.enum(["application/pdf", "image/jpeg", "image/png"]),
    size: z.number().int().positive().max(52_428_800), sha256: z.string().regex(/^[0-9a-f]{64}$/), filename: z.string().max(200),
  }).safeParse(input);
  if (!p.success) return fail("ob.err.validation");
  const { api } = await getOnboarding();
  if (api === null) return fail("state.notConfigured");
  const r = await api.createDocument(p.data.id, {
    requirement_code: p.data.requirementCode, content_type: p.data.contentType, size_bytes: p.data.size, sha256: p.data.sha256,
    ...(p.data.filename === "" ? {} : { original_filename: p.data.filename }),
  });
  if (!r.ok) return failFromApi(r.error);
  return { ok: true, data: { documentId: r.value.data.document_id, uploadUrl: r.value.data.upload_url, headers: r.value.data.upload_headers } };
}

export async function confirmDocumentAction(input: { id: string; documentId: string }): Promise<Out> {
  const p = z.object({ id: z.uuid(), documentId: z.uuid() }).safeParse(input);
  if (!p.success) return fail("ob.err.validation");
  const { api } = await getOnboarding();
  if (api === null) return fail("state.notConfigured");
  const r = await api.confirmDocument(p.data.id, p.data.documentId);
  if (!r.ok) return failFromApi(r.error);
  revalidatePath(`/apply/${p.data.id}`);
  return { ok: true, data: null };
}

export async function deleteDocumentAction(_prev: FormOut | null, form: FormData): Promise<FormOut> {
  const p = z.object({ id: z.uuid(), documentId: z.uuid() }).safeParse({ id: form.get("id"), documentId: form.get("documentId") });
  if (!p.success) return fail("ob.err.validation");
  const { api } = await getOnboarding();
  if (api === null) return fail("state.notConfigured");
  const r = await api.deleteDocument(p.data.id, p.data.documentId);
  if (!r.ok) return failFromApi(r.error);
  revalidatePath(`/apply/${p.data.id}`);
  return { ok: true, data: null };
}

export async function domainAction(_prev: FormOut | null, form: FormData): Promise<FormOut> {
  const p = z.object({
    id: z.uuid(), op: z.enum(["start", "confirm"]), method: z.enum(["dns_txt", "email"]).optional(),
    localPart: z.enum(["admin", "info", "webmaster", "hostmaster"]).optional(), code: z.string().max(12).optional(),
  }).safeParse({
    id: form.get("id"), op: form.get("op"), method: form.get("method") ?? undefined,
    localPart: form.get("localPart") || undefined, code: form.get("code") || undefined,
  });
  if (!p.success) return fail("ob.err.validation");
  const { api } = await getOnboarding();
  if (api === null) return fail("state.notConfigured");
  let code: string | undefined;
  if (p.data.code !== undefined) {
    const c = normalizeCode(p.data.code);
    if (c === null) return fail("ob.auth.err.code", { fieldErrors: { code: "ob.auth.err.code" } });
    code = c;
  }
  const r = p.data.op === "start"
    ? await api.startDomainVerification(p.data.id, { method: p.data.method ?? "dns_txt", ...(p.data.localPart === undefined ? {} : { email_local_part: p.data.localPart }) }, idem(form))
    : await api.confirmDomainVerification(p.data.id, code, idem(form));
  if (!r.ok) return failFromApi(r.error);
  revalidatePath(`/apply/${p.data.id}`);
  if (p.data.op === "confirm" && r.value.data.status !== "verified") return fail("ob.domain.notYet");
  return { ok: true, data: null, messageKey: p.data.op === "start" ? "ob.domain.started" : "ob.domain.verified" };
}

export async function submitApplicationAction(_prev: FormOut | null, form: FormData): Promise<FormOut> {
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return fail("ob.err.validation");
  if (form.get("ack_agreement") !== "on" || form.get("ack_dpa") !== "on" || form.get("ack_monitoring") !== "on") return fail("ob.err.acks");
  const { api } = await getOnboarding();
  if (api === null) return fail("state.notConfigured");
  const patch = await api.updateApplication(id.data, {
    acknowledgements: { seller_agreement_version: SELLER_AGREEMENT_VERSION, dpa_version: DPA_VERSION, price_monitoring_consent: true },
  });
  if (!patch.ok) return failFromApi(patch.error);
  const status = patch.value.data.status;
  const r = status === "NEEDS_INFO"
    ? await api.resubmitApplication(id.data, { ...(fstr(form, "note").trim() === "" ? {} : { note: fstr(form, "note").trim().slice(0, 1000) }), satisfied_item_codes: patch.value.data.requested_items.filter((i) => i.satisfied === true).map((i) => i.code) }, idem(form))
    : await api.submitApplication(id.data, idem(form));
  if (!r.ok) {
    if (r.error.kind === "validation" && r.error.code === "strong_factor_required") return fail("ob.err.step_up", { stepUp: true, code: r.error.code });
    return failFromApi(r.error);
  }
  revalidatePath(`/apply/${id.data}`);
  return { ok: true, data: null, messageKey: "ob.apply.submitted" };
}

export async function withdrawApplicationAction(_prev: FormOut | null, form: FormData): Promise<FormOut> {
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return fail("ob.err.validation");
  const { api } = await getOnboarding();
  if (api === null) return fail("state.notConfigured");
  const r = await api.withdrawApplication(id.data, idem(form));
  if (!r.ok) return failFromApi(r.error);
  revalidatePath(`/apply/${id.data}`);
  return { ok: true, data: null, messageKey: "ob.apply.withdrawn" };
}

export async function appealApplicationAction(_prev: FormOut | null, form: FormData): Promise<FormOut> {
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return fail("ob.err.validation");
  const statement = fstr(form, "statement");
  const bad = validateAppeal(statement);
  if (bad !== null) return fail(bad, { fieldErrors: { statement: bad } });
  const { api } = await getOnboarding();
  if (api === null) return fail("state.notConfigured");
  const r = await api.appealApplication(id.data, statement.trim(), idem(form));
  if (!r.ok) return failFromApi(r.error);
  revalidatePath(`/apply/${id.data}`);
  return { ok: true, data: null, messageKey: "ob.appeal.sent" };
}

/* =============================== SETTINGS =============================== */
type ProfileField = "nameAr" | "nameEn" | "descriptionAr" | "descriptionEn" | "changeOfMindDays" | "defectDays" | "policyAr" | "policyEn" | "threshold";

export async function saveProfileAction(_prev: FormOut | null, form: FormData): Promise<FormOut> {
  const section = z.enum(["profile", "returns", "delivery"]).safeParse(form.get("section"));
  if (!section.success) return fail("ob.err.validation");
  return withStore(async (api, scope) => {
    const cur = await api.profile(scope.storeId);
    if (!cur.ok) return failFromApi(cur.error);
    const expected = Number(fstr(form, "expectedVersion"));
    if (Number.isInteger(expected) && hasVersionConflict(expected, cur.value.data.version)) return fail("ob.err.conflict", { conflict: true, code: "version_conflict" });
    const base = profileValues(cur.value.data);
    const keys: Record<"profile" | "returns" | "delivery", readonly ProfileField[]> = {
      profile: ["nameAr", "nameEn", "descriptionAr", "descriptionEn"],
      returns: ["changeOfMindDays", "defectDays", "policyAr", "policyEn"],
      delivery: ["threshold"],
    };
    const next: Record<string, string> = { ...base };
    for (const k of keys[section.data]) next[k] = fstr(form, k);
    const v = next as unknown as ProfileValues;
    const errors = validateProfile(v, cur.value.data.return_policy.statutory_minimum);
    const relevant: Record<string, MessageKey> = {};
    for (const [k, m] of Object.entries(errors)) if ((keys[section.data] as readonly string[]).includes(k)) relevant[k] = m;
    if (Object.keys(relevant).length > 0) return fail("ob.err.validation", { fieldErrors: relevant });
    const r = await api.putProfile(scope.storeId, profileBody(v, cur.value.data.social_links), idem(form));
    if (!r.ok) return failFromApi(r.error);
    revalidatePath("/settings", "layout");
    return { ok: true, data: null, messageKey: "ob.set.saved" };
  });
}

export async function saveVacationAction(_prev: FormOut | null, form: FormData): Promise<FormOut> {
  const enabled = form.get("enabled") === "on";
  const untilLocal = fstr(form, "until");
  const until = untilLocal === "" ? null : cairoLocalToIso(untilLocal);
  const etaExtra = fstr(form, "etaExtraDays") || "0";
  const errors = validateVacation({ enabled, until: until ?? "", etaExtraDays: etaExtra }, Date.now());
  if (Object.keys(errors).length > 0) return fail("ob.err.validation", { fieldErrors: errors });
  return withStore(async (api, scope) => {
    const r = await api.putVacation(scope.storeId, { enabled, until: enabled ? until : null, eta_extra_days: enabled ? Number(etaExtra) : 0 }, idem(form));
    if (!r.ok) return failFromApi(r.error);
    revalidatePath("/settings", "layout");
    return { ok: true, data: null, messageKey: "ob.set.saved" };
  });
}

export async function savePayoutAction(_prev: FormOut | null, form: FormData): Promise<FormOut> {
  const iban = checkEgyptIban(fstr(form, "iban"));
  const holder = fstr(form, "holder").trim();
  const errors: Record<string, MessageKey> = {};
  if (!iban.valid && iban.problem !== null) errors.iban = IBAN_PROBLEM_KEY[iban.problem];
  if (holder.length < 2 || holder.length > 300) errors.holder = "ob.set.err.holder";
  if (Object.keys(errors).length > 0) return fail("ob.err.validation", { fieldErrors: errors });
  return withStore(async (api, scope) => {
    const r = await api.putPayoutAccount(scope.storeId, { iban: iban.normalized, account_holder_name: holder }, idem(form));
    if (!r.ok) return failFromApi(r.error);
    revalidatePath("/settings/payout");
    return { ok: true, data: null, messageKey: "ob.payout.saved" };
  });
}

export async function saveShippingAction(_prev: FormOut | null, form: FormData): Promise<FormOut> {
  const packaging = form.getAll("packaging").filter((x): x is string => typeof x === "string");
  const v = {
    governorate: fstr(form, "governorate"), city: fstr(form, "city").trim().toLowerCase(), street: fstr(form, "street"), building: fstr(form, "building"),
    landmark: fstr(form, "landmark"), contactName: fstr(form, "contactName"), contactPhone: fstr(form, "contactPhone"),
    lat: fstr(form, "lat"), lng: fstr(form, "lng"), handlingHours: fstr(form, "handlingHours"), packaging,
  };
  return withStore(async (api, scope) => {
    const cur = await api.shipping(scope.storeId);
    if (!cur.ok) return failFromApi(cur.error);
    const stored = cur.value.data.configured;
    const errors = validateShipping(v, stored);
    if (Object.keys(errors).length > 0) return fail("ob.err.validation", { fieldErrors: errors });
    const phone = v.contactPhone.trim() === "" ? null : normalizePhone(v.contactPhone);
    if (phone === null) return fail("ob.err.validation", { fieldErrors: { contactPhone: "ob.set.err.phone_again" } });
    const hasPin = v.lat.trim() !== "" && v.lng.trim() !== "";
    const r = await api.putShipping(scope.storeId, {
      origin: {
        governorate_code: v.governorate, city_code: v.city, street: v.street.trim(), building: v.building.trim() === "" ? null : v.building.trim(),
        landmark: v.landmark.trim(), contact_name: v.contactName.trim(), contact_phone: phone,
        pin: hasPin ? { lat: Number(v.lat), lng: Number(v.lng) } : null,
      },
      handling_time_hours: Number(v.handlingHours),
      courier_preferences: cur.value.data.configured ? cur.value.data.courier_preferences : { default: ["bosta"] },
      packaging_options: packaging,
    }, idem(form));
    if (!r.ok) return failFromApi(r.error);
    revalidatePath("/settings/shipping");
    return { ok: true, data: null, messageKey: "ob.set.saved" };
  });
}

export async function inviteAction(_prev: FormOut | null, form: FormData): Promise<FormOut> {
  const role = sellerRole.safeParse(form.get("role"));
  const errors = validateInvite(fstr(form, "phone"), fstr(form, "role"));
  const phone = normalizePhone(fstr(form, "phone"));
  if (Object.keys(errors).length > 0 || !role.success || phone === null) return fail("ob.err.validation", { fieldErrors: errors });
  return withStore(async (api, scope) => {
    const r = await api.invite(scope.storeId, { phone, role: role.data }, idem(form));
    if (!r.ok) return failFromApi(r.error);
    revalidatePath("/settings/team");
    return { ok: true, data: null, messageKey: "ob.team.invited" };
  });
}

export async function teamMutationAction(_prev: FormOut | null, form: FormData): Promise<FormOut> {
  const op = z.enum(["revoke", "remove", "role"]).safeParse(form.get("op"));
  const target = z.uuid().safeParse(form.get("target"));
  if (!op.success || !target.success) return fail("ob.err.validation");
  return withStore(async (api, scope) => {
    if (op.data === "revoke") {
      const r = await api.revokeInvite(scope.storeId, target.data, idem(form));
      if (!r.ok) return failFromApi(r.error);
    } else if (op.data === "remove") {
      if (target.data === scope.userId) return fail("ob.team.err.self");
      const r = await api.removeMember(scope.storeId, target.data, idem(form));
      if (!r.ok) return r.error.code === "last_owner" ? fail("ob.team.err.last_owner", { code: "last_owner" }) : failFromApi(r.error);
    } else {
      const role = sellerRole.safeParse(form.get("role"));
      if (!role.success) return fail("ob.err.validation");
      const r = await api.changeRole(scope.storeId, target.data, role.data, idem(form));
      if (!r.ok) return r.error.code === "last_owner" ? fail("ob.team.err.last_owner", { code: "last_owner" }) : failFromApi(r.error);
    }
    revalidatePath("/settings/team");
    return { ok: true, data: null, messageKey: "ob.set.saved" };
  });
}

export async function savePrefsAction(_prev: FormOut | null, form: FormData): Promise<FormOut> {
  const wanted = new Set(form.getAll("pref").filter((x): x is string => typeof x === "string"));
  const known = new Set<string>();
  for (const e of NOTIFICATION_EVENTS) for (const c of NOTIFICATION_CHANNELS) known.add(`${e}:${c}`);
  for (const w of wanted) if (!known.has(w)) return fail("ob.err.validation");
  return withStore(async (api, scope) => {
    const cur = await api.notificationPrefs(scope.storeId);
    if (!cur.ok) return failFromApi(cur.error);
    const changes = prefsChanges(prefCells(cur.value.data), wanted);
    if (Object.keys(changes).length === 0) return { ok: true, data: null, messageKey: "ob.set.nochange" };
    const r = await api.putNotificationPrefs(scope.storeId, changes, idem(form));
    if (!r.ok) return failFromApi(r.error);
    revalidatePath("/settings/notifications");
    return { ok: true, data: null, messageKey: "ob.set.saved" };
  });
}

export async function requestEtaAction(_prev: FormOut | null, form: FormData): Promise<FormOut> {
  return withStore(async (api, scope) => {
    const r = await api.requestEta(scope.storeId, idem(form));
    if (!r.ok) return failFromApi(r.error);
    revalidatePath("/settings/eta");
    return { ok: true, data: null, messageKey: "ob.eta.requested" };
  });
}

export async function createMediaUploadAction(input: { slot: "logo" | "cover"; contentType: string; size: number }): Promise<Out<{ uploadId: string; uploadUrl: string; headers: Record<string, string> }>> {
  const p = z.object({ slot: z.enum(["logo", "cover"]), contentType: z.enum(["image/jpeg", "image/png", "image/webp"]), size: z.number().int().positive().max(5_242_880) }).safeParse(input);
  if (!p.success) return fail("ob.err.validation");
  return withStore(async (api, scope) => {
    const r = await api.createMediaUpload(scope.storeId, { slot: p.data.slot, content_type: p.data.contentType, byte_size: p.data.size });
    if (!r.ok) return failFromApi(r.error);
    return { ok: true, data: { uploadId: r.value.data.upload_id, uploadUrl: r.value.data.upload_url, headers: r.value.data.headers } };
  });
}

export async function confirmMediaUploadAction(input: { uploadId: string }): Promise<Out<{ status: string }>> {
  const id = z.uuid().safeParse(input.uploadId);
  if (!id.success) return fail("ob.err.validation");
  return withStore(async (api, scope) => {
    const r = await api.confirmMediaUpload(scope.storeId, id.data);
    if (!r.ok) return failFromApi(r.error);
    revalidatePath("/settings/profile");
    return { ok: true, data: { status: r.value.data.status } };
  });
}

/** Language switch that stays on the current page (pre-store pages have no dashboard to return to). */
export async function switchLocaleAction(form: FormData): Promise<void> {
  const next = form.get("locale") === "en" ? "en" : "ar";
  (await cookies()).set(LOCALE_COOKIE, next, { path: "/", sameSite: "lax", secure: true, maxAge: 60 * 60 * 24 * 365 });
  redirect(safeNextPath(typeof form.get("path") === "string" ? String(form.get("path")) : null, "/start"));
}

/** Server-action form wrapper: creates the application then moves to its page. */
export async function startApplicationAction(_prev: FormOut | null, form: FormData): Promise<FormOut> {
  const kindRaw = fstr(form, "kind");
  const kind = kindRaw === "local" || kindRaw === "global" ? kindRaw : null;
  const country = kind === "local" ? "EG" : fstr(form, "country");
  const k = z.uuid().safeParse(form.get("idem"));
  const r = await createApplicationAction({ kind, country, brandName: fstr(form, "brandName"), ...(k.success ? { idem: k.data } : {}) });
  if (!r.ok) return r;
  redirect(`/apply/${r.data.id}`);
}

/** Form-bound variant of saveDetailsAction: every named input is a requirement field code. */
export async function saveDetailsFormAction(_prev: FormOut | null, form: FormData): Promise<FormOut> {
  const values: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string" && k !== "id" && k !== "idem" && k !== "ifMatch") values[k] = v;
  }
  const etag = fstr(form, "ifMatch");
  const r = await saveDetailsAction({ id: fstr(form, "id"), values, ifMatch: etag === "" ? null : etag });
  return r.ok ? { ok: true, data: null, ...(r.messageKey === undefined ? {} : { messageKey: r.messageKey }) } : r;
}
