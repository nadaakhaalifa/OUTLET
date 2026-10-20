"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { MEDIA_MODELS } from "../api/schemas-phase3";
import { mediaErrorKey } from "../view-models/product-media";
import { getContext } from "../server-context";
import type { ActionResult } from "./actions";

const id = z.string().uuid();
const str = (f: FormData, k: string): string => (typeof f.get(k) === "string" ? (f.get(k) as string) : "");

export async function decideMediaAction(_p: ActionResult | null, form: FormData): Promise<ActionResult> {
  const sid = id.safeParse(str(form, "storeId"));
  const jid = id.safeParse(str(form, "id"));
  const op = str(form, "op");
  const model = str(form, "model");
  if (!sid.success || !jid.success) return { ok: false, messageKey: "state.error" };
  const { api } = await getContext();
  if (api === null) return { ok: false, messageKey: "state.notConfigured" };
  let r;
  if (op === "accept") r = await api.acceptProductMedia(sid.data, jid.data);
  else if (op === "use_original") r = await api.useOriginalProductMedia(sid.data, jid.data);
  else if (op === "rerun" && (MEDIA_MODELS as readonly string[]).includes(model)) r = await api.rerunProductMedia(sid.data, jid.data, model as (typeof MEDIA_MODELS)[number]);
  else return { ok: false, messageKey: "state.error" };
  if (!r.ok) return { ok: false, messageKey: mediaErrorKey(r.error) };
  revalidatePath("/media");
  return { ok: true };
}
