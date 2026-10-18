"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { admin } from "@outlet/domain";
import type { ApiResult } from "../api/client";
import { createAdminApi, type AdminApi } from "../api/client";
import { SESSION_COOKIE } from "../session/refresh";
import { cookies } from "next/headers";
import { buildTransport, makeSession } from "./console";
import { validatePiiRequest, type PiiField } from "../view-models/pii";
import { serializeAssertionInput } from "./passkey-input";
import { validatePlusForm } from "../view-models/plus";
import { mergeRewards, validateOdds, validateRewardsEdit } from "../view-models/rewards";

const Reason = z.enum(admin.ADMIN_REASON_CODES);
const Id = z.uuid();

function apiOrNull(): AdminApi | null {
  const transport = buildTransport();
  if (transport === null) return null;
  return createAdminApi({ transport, session: makeSession(transport), newIdempotencyKey: () => crypto.randomUUID() });
}

/** Runs one mutation and returns to the screen with a flash code. The API result is the only source of truth. */
async function run(path: string, call: (api: AdminApi) => Promise<ApiResult<unknown>>): Promise<never> {
  const api = apiOrNull();
  if (api === null) return redirect(`${path}?r=not_configured`);
  const r = await call(api);
  revalidatePath(path);
  return redirect(`${path}?r=${r.ok ? "ok" : r.error.kind}`);
}

const field = (f: FormData, k: string): string => {
  const v = f.get(k);
  return typeof v === "string" ? v : "";
};

export async function approveAction(form: FormData): Promise<void> {
  const id = Id.safeParse(field(form, "id"));
  if (!id.success) return redirect("/approvals?r=validation");
  return run("/approvals", (a) => a.approve(id.data));
}
export async function rejectAction(form: FormData): Promise<void> {
  const id = Id.safeParse(field(form, "id"));
  if (!id.success) return redirect("/approvals?r=validation");
  return run("/approvals", (a) => a.reject(id.data));
}

export async function suspendSellerAction(form: FormData): Promise<void> {
  const id = Id.safeParse(field(form, "id"));
  const reason = Reason.safeParse(field(form, "reason_code"));
  if (!id.success || !reason.success) return redirect("/sellers?r=validation");
  return run("/sellers", (a) => a.suspendSeller(id.data, reason.data));
}
export async function reinstateSellerAction(form: FormData): Promise<void> {
  const id = Id.safeParse(field(form, "id"));
  const reason = Reason.safeParse(field(form, "reason_code"));
  if (!id.success || !reason.success) return redirect("/sellers?r=validation");
  return run("/sellers", (a) => a.reinstateSeller(id.data, reason.data));
}
export async function upholdReviewAction(form: FormData): Promise<void> {
  const id = Id.safeParse(field(form, "id"));
  if (!id.success) return redirect("/suspensions?r=validation");
  return run("/suspensions", (a) => a.upholdSuspension(id.data));
}
export async function reinstateFromReviewAction(form: FormData): Promise<void> {
  const seller = Id.safeParse(field(form, "seller_id"));
  const reason = Reason.safeParse(field(form, "reason_code"));
  if (!seller.success || !reason.success) return redirect("/suspensions?r=validation");
  return run("/suspensions", (a) => a.reinstateSeller(seller.data, reason.data));
}

export async function setFlagAction(form: FormData): Promise<void> {
  const key = z.string().regex(/^[a-z0-9]+(?:[._][a-z0-9]+)*$/).max(80).safeParse(field(form, "key"));
  const enabled = z.enum(["true", "false"]).safeParse(field(form, "enabled"));
  const reason = Reason.safeParse(field(form, "reason_code"));
  if (!key.success || !enabled.success || !reason.success) return redirect("/flags?r=validation");
  return run("/flags", (a) => a.setFlag(key.data, enabled.data === "true", reason.data));
}

export async function requestElevationAction(form: FormData): Promise<void> {
  const role = z.enum(admin.ADMIN_ROLE_NAMES).safeParse(field(form, "role"));
  const reason = Reason.safeParse(field(form, "reason_code"));
  const ttlRaw = field(form, "ttl_minutes").trim();
  const ttl = ttlRaw === "" ? undefined : z.coerce.number().int().min(1).max(240).safeParse(ttlRaw);
  if (!role.success || !reason.success || (ttl !== undefined && !ttl.success)) return redirect("/elevation?r=validation");
  const body = { role: role.data, reason_code: reason.data, ...(ttl === undefined || !ttl.success ? {} : { ttl_minutes: ttl.data }) };
  return run("/elevation", (a) => a.requestElevation(body));
}
export async function activateElevationAction(form: FormData): Promise<void> {
  const id = Id.safeParse(field(form, "id"));
  if (!id.success) return redirect("/elevation?r=validation");
  return run("/elevation", (a) => a.activateElevation(id.data));
}
export async function revokeElevationAction(form: FormData): Promise<void> {
  const id = Id.safeParse(field(form, "id"));
  if (!id.success) return redirect("/elevation?r=validation");
  return run("/elevation", (a) => a.revokeElevation(id.data));
}

export async function breachStepAction(form: FormData): Promise<void> {
  const id = Id.safeParse(field(form, "id"));
  const step = z.enum(["pdpc-notified", "subjects-notified", "close"]).safeParse(field(form, "step"));
  if (!id.success || !step.success) return redirect("/privacy?r=validation");
  return run("/privacy", (a) => a.breachStep(id.data, step.data));
}
export async function breachTriageAction(form: FormData): Promise<void> {
  const id = Id.safeParse(field(form, "id"));
  const d = z.enum(["notify", "no_notification_required"]).safeParse(field(form, "decision"));
  if (!id.success || !d.success) return redirect("/privacy?r=validation");
  return run("/privacy", (a) => a.breachTriage(id.data, d.data));
}

export async function requeueAction(form: FormData): Promise<void> {
  const id = Id.safeParse(field(form, "id"));
  if (!id.success) return redirect("/tax?r=validation");
  return run("/tax", (a) => a.requeueSubmission(id.data));
}

export async function moderateAction(form: FormData): Promise<void> {
  const type = z.enum(["review", "review_reply", "question", "answer"]).safeParse(field(form, "target_type"));
  const id = Id.safeParse(field(form, "target_id"));
  const d = z.enum(["publish", "reject"]).safeParse(field(form, "decision"));
  if (!type.success || !id.success || !d.success) return redirect("/moderation?r=validation");
  return run("/moderation", (a) => a.moderate(type.data, id.data, d.data));
}

export interface PiiActionState {
  readonly status: "idle" | "ok" | "error";
  readonly fields: Readonly<Record<string, string>>;
  readonly errorKey: string | null;
  readonly revealedAtMs: number | null;
}

/** PII view: the reason code is validated first; the API writes the audit row before returning any value. */
export async function viewPiiAction(_prev: PiiActionState, form: FormData): Promise<PiiActionState> {
  const checked = validatePiiRequest({
    subjectUserId: field(form, "subject_user_id").trim(),
    fields: form.getAll("fields").filter((v): v is string => typeof v === "string"),
    reasonCode: field(form, "reason_code"),
  });
  if (!checked.ok) return { status: "error", fields: {}, errorKey: checked.errors[0]?.key ?? "pii.error.fields", revealedAtMs: null };
  const api = apiOrNull();
  if (api === null) return { status: "error", fields: {}, errorKey: "state.notConfigured", revealedAtMs: null };
  const r = await api.viewPii({ ...checked.request, fields: checked.request.fields satisfies PiiField[] });
  if (!r.ok) {
    const key = r.error.kind === "forbidden" ? "state.forbidden" : r.error.kind === "not_found" ? "state.notFound" : r.error.kind === "unavailable" ? "state.unavailable" : "state.error";
    return { status: "error", fields: {}, errorKey: key, revealedAtMs: null };
  }
  return { status: "ok", fields: r.value.data.fields, errorKey: null, revealedAtMs: Date.now() };
}

// ---- sign-in --------------------------------------------------------------------------------
export async function beginPasskeyAction(): Promise<{ ok: true; challengeId: string; challenge: string; rpId: string } | { ok: false }> {
  const transport = buildTransport();
  if (transport === null) return { ok: false };
  const r = await makeSession(transport).beginPasskey();
  return r.ok ? { ok: true, challengeId: r.value.challenge_id, challenge: r.value.challenge, rpId: r.value.rp_id } : { ok: false };
}

export async function finishPasskeyAction(challengeId: string, credentialJson: string): Promise<{ ok: boolean }> {
  const transport = buildTransport();
  const parsed = serializeAssertionInput(challengeId, credentialJson);
  if (transport === null || parsed === null) return { ok: false };
  const r = await makeSession(transport).completePasskey(parsed.challengeId, parsed.credential);
  return { ok: r.ok };
}

export async function signOutAction(): Promise<void> {
  const transport = buildTransport();
  if (transport !== null) await makeSession(transport).signOut();
  else (await cookies()).delete(SESSION_COOKIE);
  return redirect("/login");
}

export async function setLocaleAction(form: FormData): Promise<void> {
  const v = field(form, "locale") === "en" ? "en" : "ar";
  (await cookies()).set("admin-locale", v, { path: "/", sameSite: "strict", secure: true, maxAge: 31_536_000 });
  const back = field(form, "back");
  return redirect(/^\/[a-z-]*$/.test(back) ? back : "/");
}

// ---- Phase 2 ------------------------------------------------------------------------------
const plusForm = (form: FormData) => ({
  code: field(form, "code").trim(), interval: field(form, "interval"), priceEgp: field(form, "price_egp"),
  trialDays: field(form, "trial_days").trim(), effectiveFrom: field(form, "effective_from"),
  kind: field(form, "kind"), seatLimit: field(form, "seat_limit"),
});

/** Step 1 of a price change: ask for a dual approval (the requester can never approve it). */
export async function requestPlusApprovalAction(form: FormData): Promise<void> {
  const v = validatePlusForm(plusForm(form), Date.now());
  const reason = Reason.safeParse(field(form, "reason_code"));
  if (!v.ok || !reason.success) return redirect("/plus?r=validation");
  return run("/plus", (a) => a.requestApproval({
    kind: "plan_price_change", subject_type: "plus_plan", subject_id: v.value.code, amount_minor: v.value.price_minor, reason_code: reason.data,
  }));
}
/** Step 2: publish with the approved approval ID. The API re-checks the approval and the 30-day notice. */
export async function publishPlusPlanAction(form: FormData): Promise<void> {
  const v = validatePlusForm(plusForm(form), Date.now());
  const approval = Id.safeParse(field(form, "approval_id").trim());
  if (!v.ok || !approval.success) return redirect("/plus?r=validation");
  return run("/plus", (a) => a.publishPlusPlan({ ...v.value, approval_id: approval.data }));
}
export async function setPlusPlanActiveAction(form: FormData): Promise<void> {
  const id = z.string().min(1).max(80).safeParse(field(form, "id"));
  const active = z.enum(["true", "false"]).safeParse(field(form, "active"));
  if (!id.success || !active.success) return redirect("/plus?r=validation");
  return run("/plus", (a) => a.setPlusPlanActive(id.data, active.data === "true"));
}

export async function voidGiftCardAction(form: FormData): Promise<void> {
  const id = Id.safeParse(field(form, "id").trim());
  if (!id.success) return redirect("/gift-cards?r=validation");
  return run("/gift-cards", (a) => a.voidGiftCard(id.data));
}

export async function saveRewardsAction(form: FormData): Promise<void> {
  const f = {
    piastresPerCoin: field(form, "piastres_per_coin").trim(), silverFrom: field(form, "silver_from").trim(), goldFrom: field(form, "gold_from").trim(),
    blackFrom: field(form, "black_from").trim(), maxCoinsPerEvent: field(form, "max_coins_per_event").trim(),
  };
  const approval = z.string().min(1).max(80).safeParse(field(form, "approval_id").trim());
  if (!validateRewardsEdit(f).ok || !approval.success) return redirect("/rewards?r=validation");
  return run("/rewards", async (a) => {
    const cur = await a.rewardsConfig();
    if (!cur.ok) return cur;
    return a.putRewardsConfig(mergeRewards(cur.value.data, f, approval.data));
  });
}

/** Odds rows arrive as parallel arrays; the same pure validator as the editor refuses anything but 100%. */
export async function publishOddsAction(form: FormData): Promise<void> {
  const game = z.enum(["daily_spin", "scratch_card"]).safeParse(field(form, "game"));
  const approval = z.string().min(1).max(80).safeParse(field(form, "approval_id").trim());
  const ids = form.getAll("o_id"), kinds = form.getAll("o_kind"), pcts = form.getAll("o_percent"), coins = form.getAll("o_coins"), vouchers = form.getAll("o_voucher");
  const str = (x: FormDataEntryValue | undefined): string => (typeof x === "string" ? x.trim() : "");
  const rows = ids.map((_, i) => ({ id: str(ids[i]), kind: str(kinds[i]), percent: str(pcts[i]), coins: str(coins[i]), voucher: str(vouchers[i]) }));
  const v = validateOdds(rows);
  if (!game.success || !approval.success || !v.ok) return redirect("/rewards?r=validation");
  return run("/rewards", (a) => a.publishGameOdds(game.data, { approval_id: approval.data, outcomes: v.outcomes }));
}

export async function controlDropAction(form: FormData): Promise<void> {
  const id = Id.safeParse(field(form, "id").trim());
  const action = z.enum(["pause", "resume", "end"]).safeParse(field(form, "action"));
  if (!id.success || !action.success) return redirect("/drops?r=validation");
  return run("/drops", (a) => a.controlDrop(id.data, action.data));
}
