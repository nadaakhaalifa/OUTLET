import { z } from "zod";
import { dataOf, type schemas } from "../../services/api-client";
import { ms, piastres, type AdapterContext } from "../../services/wire";
import { aiGuard, AiFailure } from "../ai-failure";
import { outfitFromWire } from "../stylist/wire-outfit";
import type {
  ChatAction, ChatBlock, ChatInput, ChatLang, ChatMessage, ChatOption, ChatOutfit, ChatPort, ChatSession, ChatSettings, ChatTurn, ChipTopic, LiveItem,
} from "./model";
import { isRefusalCode } from "./model";

const Option = z.looseObject({ id: z.string(), label_ar: z.string(), label_en: z.string() });
const OutfitWire = z.looseObject({
  id: z.string(),
  complete: z.boolean().optional(),
  items: z.array(z.looseObject({ item_id: z.string(), store_id: z.string(), slot: z.string(), price_piastres: z.string() })),
  per_store: z.array(z.looseObject({ store_id: z.string() })).default([]),
  missing: z.array(z.looseObject({ slot: z.string(), add_piastres: z.string().nullable().default(null) })).default([]),
  live: z.array(z.looseObject({ item_id: z.string(), available: z.boolean(), current_price_piastres: z.string().nullable(), price_changed: z.boolean() })).default([]),
});
const BlockWire = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("text"), code: z.string().default(""), text: z.string() }),
  z.looseObject({ type: z.literal("outfits"), outfits: z.array(OutfitWire) }),
  z.looseObject({ type: z.literal("chips"), topic: z.enum(["palette", "occasion", "budget", "swap_slot"]), options: z.array(Option) }),
  z.looseObject({ type: z.literal("quick_actions"), options: z.array(Option) }),
]);

const option = (o: z.infer<typeof Option>): ChatOption => ({ id: o.id, labelAr: o.label_ar, labelEn: o.label_en });

/** Blocks are `looseObject` on the wire: each is validated here, and an unknown or malformed block is dropped, never rendered. */
export function parseBlocks(raw: readonly unknown[]): readonly ChatBlock[] {
  const out: ChatBlock[] = [];
  for (const r of raw) {
    const p = BlockWire.safeParse(r);
    if (!p.success) continue;
    const b = p.data;
    if (b.type === "text") out.push({ kind: "text", code: b.code, text: b.text, refusal: isRefusalCode(b.code) });
    else if (b.type === "chips") out.push({ kind: "chips", topic: b.topic as ChipTopic, options: b.options.map(option) });
    else if (b.type === "quick_actions") out.push({ kind: "quick", options: b.options.map(option) });
    else {
      const outfits: ChatOutfit[] = b.outfits.map((o) => {
        const live: Record<string, LiveItem> = {};
        for (const l of o.live) {
          live[l.item_id] = { available: l.available, currentPrice: l.current_price_piastres === null ? null : piastres(l.current_price_piastres), priceChanged: l.price_changed };
        }
        return {
          outfit: outfitFromWire({ id: o.id, items: o.items, per_store: o.per_store, missing: o.missing.map((m) => ({ slot: m.slot, add_piastres: m.add_piastres })) }),
          complete: o.complete ?? o.missing.length === 0,
          live,
        };
      });
      out.push({ kind: "outfits", outfits });
    }
  }
  return out;
}

function sessionOf(s: { id: string; language?: string | undefined; history_enabled?: boolean | undefined; updated_at?: string | undefined; created_at?: string | undefined }): ChatSession {
  return {
    id: s.id,
    language: s.language === "en" ? "en" : "ar",
    historyEnabled: s.history_enabled ?? false,
    updatedAtMs: ms(s.updated_at ?? s.created_at ?? new Date(0).toISOString()),
  };
}

function wireAction(a: ChatAction): schemas.StylistChatMessage["action"] {
  return {
    type: a.type,
    ...(a.world !== undefined ? { world: a.world } : {}),
    ...(a.topic !== undefined ? { topic: a.topic } : {}),
    ...(a.value !== undefined ? { value: a.value } : {}),
  };
}

/**
 * /v1/stylist/chat/* and /v1/me/stylist-chat/settings. The client attaches a fresh UUIDv7 Idempotency-Key to every
 * write, which is also the chat client message id. Assistant reply text is the server's fixed catalogue text.
 */
export class ApiStylistChatPort implements ChatPort {
  constructor(private readonly ctx: AdapterContext) {}

  listSessions(): Promise<readonly ChatSession[]> {
    return aiGuard(async () => dataOf(await this.ctx.client.listStylistChatSessions()).items.map(sessionOf));
  }

  createSession(lang: ChatLang): Promise<ChatSession> {
    return aiGuard(async () => sessionOf(dataOf(await this.ctx.client.createStylistChatSession({ body: { locale: lang } }))));
  }

  loadSession(id: string): Promise<{ session: ChatSession; messages: readonly ChatMessage[] }> {
    return aiGuard(async () => {
      const v = dataOf(await this.ctx.client.getStylistChatSession({ path: { sessionId: id } }));
      const messages: ChatMessage[] = v.turns.map((t) => ({
        id: `${id}:${t.seq}:${t.role}`,
        role: t.role,
        text: t.text ?? null,
        blocks: parseBlocks(t.blocks),
        source: t.source === "llm" || t.source === "rules" ? t.source : null,
      }));
      return { session: sessionOf(v), messages };
    });
  }

  send(sessionId: string, input: ChatInput, lang: ChatLang): Promise<ChatTurn> {
    return aiGuard(async () => {
      const body: schemas.StylistChatMessage = "text" in input ? { text: input.text, locale: lang } : { action: wireAction(input.action), locale: lang };
      const t = dataOf(await this.ctx.client.sendStylistChatMessage({ path: { sessionId }, body }));
      if (t.session_id !== sessionId) throw new AiFailure("failed");
      return {
        turnId: t.turn_id,
        seq: t.seq,
        source: t.source,
        intent: t.intent,
        blocks: parseBlocks(t.blocks),
        truncated: t.truncated,
        remainingToday: t.quota.remaining_today ?? null,
      };
    });
  }

  deleteSession(id: string): Promise<void> {
    return aiGuard(async () => {
      dataOf(await this.ctx.client.deleteStylistChatSession({ path: { sessionId: id } }));
    });
  }

  getSettings(): Promise<ChatSettings> {
    return aiGuard(async () => ({ historyEnabled: dataOf(await this.ctx.client.getStylistChatSettings()).history_enabled }));
  }

  setHistoryEnabled(enabled: boolean): Promise<ChatSettings> {
    return aiGuard(async () => ({ historyEnabled: dataOf(await this.ctx.client.updateStylistChatSettings({ body: { history_enabled: enabled } })).history_enabled }));
  }
}
