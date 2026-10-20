import type { RenderedBlock, SessionView, ChatTurnView } from "../application/chat";
import type { ChatSessionRecord } from "../domain/chat-ports";
import { outfitWire } from "./wire";

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Wire shapes (snake_case, money as piastre strings). Every payload carries the "AI suggestions"
 * label (LLM09). Reply text is rendered from the fixed catalogue; prices are catalogue rows.
 */
export function blockWire(b: RenderedBlock) {
  switch (b.type) {
    case "text":
      return { type: "text" as const, code: b.code, text: b.text, language: b.lang };
    case "outfits":
      return {
        type: "outfits" as const,
        outfits: b.outfits.map((o) => ({
          ...outfitWire(o.record),
          live: o.items.map((i) => ({
            item_id: i.itemId,
            available: i.available,
            current_price_piastres: i.currentPricePiastres === null ? null : i.currentPricePiastres.toString(),
            price_changed: i.priceChanged,
          })),
        })),
        add_to_bag: b.outfits.map((o) => ({ outfit_id: o.record.id, path: `/v1/stylist/outfits/${o.record.id}/add-to-bag` })),
      };
    case "chips":
      return { type: "chips" as const, topic: b.topic, options: b.options.map((o) => ({ id: o.id, label_ar: o.ar, label_en: o.en })) };
    case "quick_actions":
      return { type: "quick_actions" as const, options: b.options.map((o) => ({ id: o.id, label_ar: o.ar, label_en: o.en })) };
  }
}

export function sessionWire(s: ChatSessionRecord) {
  return {
    id: s.id,
    ai_notice: "AI suggestions" as const,
    language: s.state.language,
    scope: { world: s.state.world, store_ids: s.state.storeIds },
    history_enabled: s.historyEnabled,
    created_at: iso(s.createdAtMs),
    updated_at: iso(s.updatedAtMs),
  };
}

export function turnWire(v: ChatTurnView) {
  return {
    ai_notice: "AI suggestions" as const,
    session_id: v.sessionId,
    turn_id: v.turnId,
    seq: v.seq,
    source: v.source,
    intent: v.intent,
    language: v.language,
    blocks: v.blocks.map(blockWire),
    truncated: v.truncated,
    replay: v.replay,
    quota: { remaining_today: v.remainingTurnsToday },
  };
}

export function sessionViewWire(v: SessionView) {
  return {
    ...sessionWire(v.session),
    turns: v.turns.map((t) => ({
      seq: t.seq,
      role: t.role,
      text: t.text,
      source: t.source,
      blocks: t.blocks.map(blockWire),
      created_at: iso(t.createdAtMs),
    })),
  };
}
