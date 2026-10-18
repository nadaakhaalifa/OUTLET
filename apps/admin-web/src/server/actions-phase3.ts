"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createAdminApi, type AdminApi, type ApiResult } from "../api/client";
import { CREATOR_DECISIONS } from "../api/phase3-schemas";
import { decisionReasonError } from "../view-models/creators";
import { validateGuardrailForm, validateRunForm } from "../view-models/ranking";
import { buildTransport, makeSession } from "./console";

const Id = z.uuid();

function apiOrNull(): AdminApi | null {
  const transport = buildTransport();
  if (transport === null) return null;
  return createAdminApi({ transport, session: makeSession(transport), newIdempotencyKey: () => crypto.randomUUID() });
}

async function run(path: string, call: (api: AdminApi) => Promise<ApiResult<unknown>>, extra = ""): Promise<never> {
  const api = apiOrNull();
  if (api === null) return redirect(`${path}?r=not_configured`);
  const r = await call(api);
  revalidatePath(path);
  return redirect(`${path}?r=${r.ok ? "ok" : r.error.kind}${r.ok ? extra : ""}`);
}

const field = (f: FormData, k: string): string => {
  const v = f.get(k);
  return typeof v === "string" ? v : "";
};

export async function decideCreatorAction(form: FormData): Promise<void> {
  const id = Id.safeParse(field(form, "id"));
  const action = z.enum(CREATOR_DECISIONS).safeParse(field(form, "action"));
  const reason = field(form, "reason").trim();
  if (!id.success || !action.success || decisionReasonError(action.data, reason) !== null) return redirect("/creators?r=validation");
  return run("/creators", (a) => a.decideCreator(id.data, action.data, reason === "" ? null : reason));
}

export async function createCreatorPayoutAction(form: FormData): Promise<void> {
  const creator = Id.safeParse(field(form, "creator_id").trim());
  if (!creator.success) return redirect("/creators?r=validation");
  return run("/creators", (a) => a.createCreatorPayout(creator.data));
}

export async function creatorPayoutStepAction(form: FormData): Promise<void> {
  const id = Id.safeParse(field(form, "id"));
  const step = z.enum(["approve", "send", "cancel", "settled", "rejected"]).safeParse(field(form, "step"));
  if (!id.success || !step.success) return redirect("/creators?r=validation");
  const s = step.data;
  if (s === "approve") return run("/creators", (a) => a.approveCreatorPayout(id.data));
  if (s === "send") return run("/creators", (a) => a.sendCreatorPayout(id.data));
  if (s === "cancel") return run("/creators", (a) => a.cancelCreatorPayout(id.data));
  const ref = z.string().max(128).safeParse(field(form, "provider_ref").trim());
  if (!ref.success || (s === "settled" && ref.data === "")) return redirect("/creators?r=validation");
  return run("/creators", (a) => a.recordCreatorPayoutOutcome(id.data, s === "settled" ? { outcome: "settled", provider_ref: ref.data } : { outcome: "rejected", ...(ref.data === "" ? {} : { reason: ref.data }) }));
}

export async function runRankingEvaluationAction(form: FormData): Promise<void> {
  const v = validateRunForm({
    requestKey: field(form, "request_key"), candidate: field(form, "candidate"), baseline: field(form, "baseline"),
    seed: field(form, "seed"), requests: field(form, "requests"), k: field(form, "k"),
  });
  if (!v.ok) return redirect("/ranking?r=validation");
  return run("/ranking", (a) => a.runRankingEvaluation(v.value));
}

export async function evaluateGuardrailsAction(form: FormData): Promise<void> {
  const arm = (p: string) => ({ orders: field(form, `${p}_orders`), returned: field(form, `${p}_returned`), complaints: field(form, `${p}_complaints`) });
  const v = validateGuardrailForm({
    control: arm("c"), treatment: arm("t"),
    minOrders: field(form, "min_orders"), maxReturnBps: field(form, "max_return_bps"), maxComplaintBps: field(form, "max_complaint_bps"),
  });
  if (!v.ok) return redirect("/ranking?r=validation");
  const api = apiOrNull();
  if (api === null) return redirect("/ranking?r=not_configured");
  const r = await api.evaluateRankingGuardrails(v.body);
  if (!r.ok) return redirect(`/ranking?r=${r.error.kind}`);
  const g = r.value.data;
  const q = new URLSearchParams({ r: "ok", g: g.decision, gb: g.breaches.join(","), grd: String(g.return_rate_delta_bps ?? ""), gcd: String(g.complaint_rate_delta_bps ?? "") });
  return redirect(`/ranking?${q.toString()}`);
}
