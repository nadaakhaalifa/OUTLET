"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ApiError, ApiResult, SellerApi } from "../api/client";
import { channelType } from "../api/schemas-phase2";
import { RedirectOAuth } from "../channels/oauth-port";
import type { MessageKey } from "../i18n";
import { parseEgpToMinor } from "../lib/money-input";
import { getContext } from "../server-context";
import { validateCampaign } from "../view-models/ads";
import { checkStockEdit, validateDrop } from "../view-models/drops";
import { normaliseShopDomain } from "../view-models/channels";
import type { ActionResult } from "./actions";

const id = z.string().uuid();
const str = (f: FormData, k: string): string => {
  const v = f.get(k);
  return typeof v === "string" ? v : "";
};

const keyFor = (e: ApiError): MessageKey => {
  if (e.code === "advertising_blocked") return "ads.blocked";
  switch (e.kind) {
    case "forbidden": return "state.forbidden";
    case "not_found": return "state.notFound";
    case "unauthorized": return "state.sessionExpired";
    case "rate_limited": return "state.rateLimited";
    case "offline": return "state.offline";
    default: return "state.error";
  }
};

async function run<T>(path: string, fn: (api: SellerApi) => Promise<ApiResult<T>>): Promise<ActionResult> {
  const { api } = await getContext();
  if (api === null) return { ok: false, messageKey: "state.notConfigured" };
  const r = await fn(api);
  if (!r.ok) return { ok: false, messageKey: keyFor(r.error) };
  revalidatePath(path);
  return { ok: true };
}

export async function setCampaignStatusAction(_p: ActionResult | null, form: FormData): Promise<ActionResult> {
  const cid = id.safeParse(str(form, "id"));
  const to = str(form, "to");
  if (!cid.success || (to !== "pause" && to !== "resume")) return { ok: false, messageKey: "state.error" };
  return run("/ads", (api) => (to === "pause" ? api.pauseAdCampaign(cid.data) : api.resumeAdCampaign(cid.data)));
}

export async function createCampaignAction(_p: ActionResult | null, form: FormData): Promise<ActionResult> {
  const v = validateCampaign({
    storeId: str(form, "storeId"), name: str(form, "name"), dailyBudget: str(form, "dailyBudget"), maxCpc: str(form, "maxCpc"),
    startsAtLocal: str(form, "startsAt"), endsAtLocal: str(form, "endsAt"), productId: str(form, "productId"), bid: str(form, "bid"), keywords: str(form, "keywords"),
  });
  if (!v.ok) return { ok: false, messageKey: v.errors[0] ?? "state.error" };
  return run("/ads", (api) => api.createAdCampaign(v.value));
}

export async function topUpAction(_p: ActionResult | null, form: FormData): Promise<ActionResult> {
  const sid = id.safeParse(str(form, "storeId"));
  const minor = parseEgpToMinor(str(form, "amount"));
  if (!sid.success || minor === null) return { ok: false, messageKey: "ads.err.amount" };
  return run("/ads", (api) => api.topUpAds(sid.data, minor));
}

export async function createDropAction(_p: ActionResult | null, form: FormData): Promise<ActionResult> {
  const v = validateDrop({
    type: str(form, "type"), title: str(form, "title"), startsAtLocal: str(form, "startsAt"), earlyAccessLocal: str(form, "earlyAccess"),
    endsAtLocal: str(form, "endsAt"), skuId: str(form, "skuId"), stockCap: str(form, "stockCap"), price: str(form, "price"),
    perUser: str(form, "perUser"), perDevice: str(form, "perDevice"), ladderAtLocal: str(form, "ladderAt"), ladderPrice: str(form, "ladderPrice"),
    mysteryMin: str(form, "mysteryMin"), mysteryMax: str(form, "mysteryMax"), mysteryGuaranteed: str(form, "mysteryGuaranteed"),
  });
  if (!v.ok) return { ok: false, messageKey: v.errors[0] ?? "state.error" };
  return run("/drops", (api) => api.createDrop(v.value));
}

export async function scheduleDropAction(_p: ActionResult | null, form: FormData): Promise<ActionResult> {
  const did = id.safeParse(str(form, "id"));
  if (!did.success) return { ok: false, messageKey: "state.error" };
  return run("/drops", (api) => api.scheduleDrop(did.data));
}

/** Raises one item's stock cap. Re-checks the rule server-side: after SCHEDULED stock can only go up and nothing else changes. */
export async function raiseStockAction(_p: ActionResult | null, form: FormData): Promise<ActionResult> {
  const did = id.safeParse(str(form, "id"));
  const sku = id.safeParse(str(form, "sku"));
  const price = /^\d{1,18}$/.test(str(form, "price")) ? BigInt(str(form, "price")) : null;
  const current = /^\d{1,6}$/.test(str(form, "current")) ? Number(str(form, "current")) : null;
  const next = /^\d{1,6}$/.test(str(form, "stock")) ? Number(str(form, "stock")) : null;
  const version = /^\d{1,9}$/.test(str(form, "version")) ? Number(str(form, "version")) : null;
  if (!did.success || !sku.success || price === null || current === null || next === null || version === null) return { ok: false, messageKey: "state.error" };
  if (checkStockEdit(str(form, "state"), [{ sku_id: sku.data, stock_cap: current, price }], [{ sku_id: sku.data, stock_cap: next, price }]).length > 0 || next > 100000) {
    return { ok: false, messageKey: "drops.err.decrease" };
  }
  return run("/drops", (api) => api.increaseDropStock(did.data, version, [{ sku_id: sku.data, stock_cap: next, price: price.toString() }]));
}

export async function withdrawResaleAction(_p: ActionResult | null, form: FormData): Promise<ActionResult> {
  const sid = id.safeParse(str(form, "storeId"));
  const lid = id.safeParse(str(form, "id"));
  if (!sid.success || !lid.success) return { ok: false, messageKey: "state.error" };
  return run("/resale", (api) => api.withdrawResale(sid.data, lid.data));
}

export async function connectChannelAction(_p: ActionResult | null, form: FormData): Promise<ActionResult> {
  const type = channelType.safeParse(str(form, "type"));
  if (!type.success) return { ok: false, messageKey: "state.error" };
  const domain = normaliseShopDomain(str(form, "domain"));
  if (domain === null) return { ok: false, messageKey: "channels.err.domain" };
  const { api } = await getContext();
  if (api === null) return { ok: false, messageKey: "state.notConfigured" };
  const r = await api.connectChannel({ type: type.data, shop_domain: domain });
  if (!r.ok) return { ok: false, messageKey: keyFor(r.error) };
  revalidatePath("/channels");
  const c = r.value.data;
  if (c.status !== "pending_oauth") return { ok: true };
  if (c.connect_url === undefined) return { ok: false, messageKey: "channels.err.pending" };
  const next = await new RedirectOAuth().begin({ type: c.type, shopDomain: c.shop_domain, connectUrl: c.connect_url });
  if (!next.ok) return { ok: false, messageKey: "channels.err.untrusted" };
  redirect(next.value.redirectTo);
}
