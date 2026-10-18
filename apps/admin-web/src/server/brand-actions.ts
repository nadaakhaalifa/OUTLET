"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ApiResult } from "../api/client";
import { createAdminApi, type AdminApi } from "../api/client";
import { DOCUMENT_READ_REASONS, type DocumentReadReason } from "../api/brand-schemas";
import { buildTransport, makeSession } from "./console";
import { flashCode, isConflictOutcome, validateDecision, validateNote } from "../view-models/brand-review";

/*
 * Server actions for the brand application review console. Nothing here logs: request bodies hold applicant PII
 * and document URLs are credentials. Every write carries the Idempotency-Key minted when the page was rendered, so a
 * double click or a retry replays the stored response instead of acting twice.
 */
const Id = z.uuid();
const Idem = z.uuid();

function apiOrNull(): AdminApi | null {
  const transport = buildTransport();
  if (transport === null) return null;
  return createAdminApi({ transport, session: makeSession(transport), newIdempotencyKey: () => crypto.randomUUID() });
}

const field = (f: FormData, k: string): string => {
  const v = f.get(k);
  return typeof v === "string" ? v : "";
};
const keyOf = (f: FormData): string => {
  const k = Idem.safeParse(field(f, "idem"));
  return k.success ? k.data : crypto.randomUUID();
};

async function run(form: FormData, call: (api: AdminApi, id: string, key: string) => Promise<ApiResult<unknown>>): Promise<never> {
  const id = Id.safeParse(field(form, "id"));
  if (!id.success) return redirect("/brand-applications?r=validation");
  const path = `/brand-applications/${id.data}`;
  const api = apiOrNull();
  if (api === null) return redirect(`${path}?r=not_configured`);
  const r = await call(api, id.data, keyOf(form));
  revalidatePath(path);
  revalidatePath("/brand-applications");
  return redirect(`${path}?r=${r.ok ? "ok" : flashCode(r.error)}`);
}

export async function claimBrandAction(form: FormData): Promise<void> {
  return run(form, (a, id, key) => a.claimBrand(id, key));
}
export async function releaseBrandAction(form: FormData): Promise<void> {
  return run(form, (a, id, key) => a.releaseBrand(id, key));
}
export async function trademarkLookupAction(form: FormData): Promise<void> {
  return run(form, (a, id, key) => a.brandTrademarkLookup(id, key));
}

export async function decideBrandAction(form: FormData): Promise<void> {
  const v = validateDecision({
    decision: field(form, "decision"),
    reasonCode: field(form, "reason_code"),
    messageAr: field(form, "message_ar"),
    messageEn: field(form, "message_en"),
    items: form.getAll("item").filter((x): x is string => typeof x === "string").map((x) => {
      const [code = "", kind = ""] = x.split("|");
      return { code, kind };
    }),
    internalNote: field(form, "internal_note"),
    reapplyAfterDays: field(form, "reapply_after_days"),
    slug: field(form, "slug"),
  });
  if (!v.ok) {
    const id = Id.safeParse(field(form, "id"));
    return redirect(id.success ? `/brand-applications/${id.data}?r=validation` : "/brand-applications?r=validation");
  }
  return run(form, (a, id, key) => a.decideBrand(id, v.body, key));
}

export async function cosignBrandAction(form: FormData): Promise<void> {
  const n = validateNote(field(form, "internal_note"));
  if (!n.ok) {
    const id = Id.safeParse(field(form, "id"));
    return redirect(id.success ? `/brand-applications/${id.data}?r=validation` : "/brand-applications?r=validation");
  }
  return run(form, (a, id, key) => a.cosignBrand(id, n.note, key));
}

export async function resolveBrandConflictAction(form: FormData): Promise<void> {
  const outcome = field(form, "outcome");
  const n = validateNote(field(form, "internal_note"));
  const id = Id.safeParse(field(form, "id"));
  if (!isConflictOutcome(outcome) || !n.ok) return redirect(id.success ? `/brand-applications/${id.data}?r=validation` : "/brand-applications?r=validation");
  return run(form, (a, aid, key) => a.resolveBrandConflict(aid, outcome, n.note, key));
}

export type DocumentReadOutcome =
  | { readonly ok: true; readonly url: string; readonly expiresAt: string; readonly serverNowMs: number }
  | { readonly ok: false; readonly kind: string };

/**
 * Called from the viewer (a client component), so it RETURNS the result instead of redirecting: the signed URL must
 * stay in memory and never appear in a URL, a flash code, a revalidated cache entry or a log line. The API audits the
 * reason code before it returns the URL.
 */
export async function readBrandDocumentAction(input: {
  readonly applicationId: string;
  readonly documentId: string;
  readonly reason: string;
  readonly key: string;
}): Promise<DocumentReadOutcome> {
  const app = Id.safeParse(input.applicationId);
  const doc = Id.safeParse(input.documentId);
  const key = Idem.safeParse(input.key);
  const reason = (DOCUMENT_READ_REASONS as readonly string[]).includes(input.reason) ? (input.reason as DocumentReadReason) : null;
  if (!app.success || !doc.success || !key.success || reason === null) return { ok: false, kind: "validation" };
  const api = apiOrNull();
  if (api === null) return { ok: false, kind: "not_configured" };
  const r = await api.brandDocumentReadUrl(app.data, doc.data, reason, key.data);
  if (!r.ok) return { ok: false, kind: r.error.kind === "conflict" && r.error.code !== undefined ? flashCode(r.error) : r.error.kind };
  return { ok: true, url: r.value.data.url, expiresAt: r.value.data.expires_at, serverNowMs: r.value.serverNowMs ?? Date.now() };
}
