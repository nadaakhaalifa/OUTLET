"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ApiError, ApiResult } from "../api/client";
import { rejectReason, rejectionReason } from "../api/schemas";
import type { MessageKey } from "../i18n";
import { validateProduct, type ProductDraft } from "../view-models/product-form";
import { LOCALE_COOKIE, getContext } from "../server-context";

export type ActionResult =
  | { readonly ok: true; readonly shipmentId?: string }
  | { readonly ok: false; readonly messageKey: MessageKey };

const idSchema = z.string().uuid();

const keyForError = (e: ApiError): MessageKey => {
  switch (e.kind) {
    case "forbidden": return "state.forbidden";
    case "not_found": return "state.notFound";
    case "unauthorized": return "state.sessionExpired";
    case "rate_limited": return "state.rateLimited";
    case "offline": return "state.offline";
    default: return "state.error";
  }
};

async function run<T>(path: string, fn: (api: NonNullable<Awaited<ReturnType<typeof getContext>>["api"]>) => Promise<ApiResult<T>>): Promise<ActionResult> {
  const { api } = await getContext();
  if (api === null) return { ok: false, messageKey: "state.notConfigured" };
  const r = await fn(api);
  if (!r.ok) return { ok: false, messageKey: keyForError(r.error) };
  revalidatePath(path);
  return { ok: true };
}

export async function acceptOrderAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const id = idSchema.safeParse(form.get("id"));
  if (!id.success) return { ok: false, messageKey: "state.error" };
  return run("/orders", (api) => api.acceptOrder(id.data));
}

export async function rejectOrderAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const id = idSchema.safeParse(form.get("id"));
  const reason = rejectReason.safeParse(form.get("reason"));
  if (!id.success || !reason.success) return { ok: false, messageKey: "state.error" };
  return run("/orders", (api) => api.rejectOrder(id.data, reason.data));
}

export async function packOrderAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const id = idSchema.safeParse(form.get("id"));
  if (!id.success) return { ok: false, messageKey: "state.error" };
  return run("/orders", (api) => api.packOrder(id.data));
}

export async function createShipmentAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const id = idSchema.safeParse(form.get("id"));
  if (!id.success) return { ok: false, messageKey: "state.error" };
  const { api } = await getContext();
  if (api === null) return { ok: false, messageKey: "state.notConfigured" };
  const r = await api.createShipment([id.data]);
  if (!r.ok) return { ok: false, messageKey: keyForError(r.error) };
  revalidatePath("/orders");
  return { ok: true, shipmentId: r.value.data.id };
}

export async function inspectReturnAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const id = idSchema.safeParse(form.get("id"));
  if (!id.success) return { ok: false, messageKey: "state.error" };
  const decision = form.get("decision");
  if (decision === "approve") return run("/returns", (api) => api.inspectReturn(id.data, { result: "approve" }));
  const reason = rejectionReason.safeParse(form.get("reason"));
  if (!reason.success) return { ok: false, messageKey: "state.error" };
  // Rejection needs photo upload ids; no upload endpoint exists in the contract yet, so this fails closed.
  return { ok: false, messageKey: "returns.photosRequired" };
}

export async function setPromotionStatusAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const id = idSchema.safeParse(form.get("id"));
  const status = z.enum(["paused", "active"]).safeParse(form.get("status"));
  if (!id.success || !status.success) return { ok: false, messageKey: "state.error" };
  return run("/marketing", (api) => api.setPromotionStatus(id.data, status.data));
}

export async function inviteMemberAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const parsed = z.object({ email: z.string().email().max(254), role: z.enum(["manager", "fulfilment", "catalog", "finance"]) }).safeParse({
    email: form.get("email"),
    role: form.get("role"),
  });
  if (!parsed.success) return { ok: false, messageKey: "state.error" };
  return run("/team", (api) => api.inviteMember(parsed.data));
}

export async function removeMemberAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const id = idSchema.safeParse(form.get("id"));
  if (!id.success) return { ok: false, messageKey: "state.error" };
  return run("/team", (api) => api.removeMember(id.data));
}

export async function beginPasskeyAction(): Promise<
  { readonly ok: true; readonly challengeId: string; readonly challenge: string; readonly rpId: string } | { readonly ok: false; readonly messageKey: MessageKey }
> {
  const { auth } = await getContext();
  if (auth === null) return { ok: false, messageKey: "state.notConfigured" };
  const r = await auth.beginPasskey();
  if (!r.ok) return { ok: false, messageKey: r.error === "network" ? "state.offline" : "login.failed" };
  return { ok: true, challengeId: r.value.challenge_id, challenge: r.value.challenge, rpId: r.value.rp_id };
}

export async function completePasskeyAction(challengeId: string, credential: unknown): Promise<ActionResult> {
  const id = idSchema.safeParse(challengeId);
  if (!id.success) return { ok: false, messageKey: "login.failed" };
  const { auth } = await getContext();
  if (auth === null) return { ok: false, messageKey: "state.notConfigured" };
  const r = await auth.completePasskey(id.data, credential);
  if (!r.ok) return { ok: false, messageKey: r.error === "network" ? "state.offline" : "login.failed" };
  return { ok: true };
}

export async function verifyTotpAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const code = z.string().regex(/^\d{6}$/).safeParse(form.get("code"));
  if (!code.success) return { ok: false, messageKey: "login.failed" };
  const { auth } = await getContext();
  if (auth === null) return { ok: false, messageKey: "state.notConfigured" };
  const r = await auth.verifyTotp(code.data);
  return r.ok ? { ok: true } : { ok: false, messageKey: "login.totpUnavailable" };
}

export async function signOutAction(): Promise<void> {
  const { session } = await getContext();
  await session?.signOut();
  redirect("/login");
}

export async function setLocaleAction(form: FormData): Promise<void> {
  const next = form.get("locale") === "en" ? "en" : "ar";
  (await cookies()).set(LOCALE_COOKIE, next, { path: "/", sameSite: "lax", secure: true, maxAge: 60 * 60 * 24 * 365 });
  redirect("/dashboard");
}

const draftSchema = z.object({
  titleAr: z.string().max(300), titleEn: z.string().max(300), descriptionAr: z.string().max(5000),
  categoryId: z.string().max(64),
  condition: z.enum(["new_with_tags", "new_without_tags", "sample", "minor_defect"]),
  defectPhotoUploadIds: z.array(z.string().uuid()).max(10),
  imageUploadIds: z.array(z.string().uuid()).max(20),
  sizeChartId: z.string().max(64),
  skus: z.array(z.object({ sizeLabel: z.string().max(12), price: z.string().max(16), stock: z.string().max(8) })).max(60),
});

/** Re-validates the draft on the server with the same pure rules, then creates the product. */
export async function createProductAction(draft: unknown): Promise<ActionResult & { readonly productId?: string }> {
  const parsed = draftSchema.safeParse(draft);
  if (!parsed.success) return { ok: false, messageKey: "state.error" };
  const checked = validateProduct(parsed.data as ProductDraft);
  if (checked.body === null) return { ok: false, messageKey: checked.errors[0]?.messageKey ?? "state.error" };
  const { api } = await getContext();
  if (api === null) return { ok: false, messageKey: "state.notConfigured" };
  const r = await api.createProduct(checked.body);
  if (!r.ok) return { ok: false, messageKey: keyForError(r.error) };
  revalidatePath("/catalog");
  return { ok: true, productId: r.value.data.id };
}

export async function saveSizeChartAction(body: unknown): Promise<ActionResult> {
  const parsed = z.object({
    product_type: z.string().max(40), unit: z.enum(["cm", "in"]),
    rows: z.array(z.object({ size_label: z.string().max(12), measurements: z.record(z.string(), z.number()) })).max(30),
  }).safeParse(body);
  if (!parsed.success) return { ok: false, messageKey: "state.error" };
  return run("/catalog", (api) => api.createSizeChart(parsed.data));
}
