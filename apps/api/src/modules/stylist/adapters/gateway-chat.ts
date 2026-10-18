import { STYLIST_CHAT_INTENT, canonicalJson, detectInjection, type LlmGateway } from "../../llm-gateway";
import { chatBudgetBand, normalizeText, type ParsedIntent } from "../domain/chat";
import type { ChatEvent, ChatIntentInput, ChatIntentOutcome, StylistChatIntentPort, StylistChatStore } from "../domain/chat-ports";
import type { Season } from "../domain/bridge";
import type { StylistLlmPort } from "../domain/ports";

/**
 * StylistChatIntentPort over llm-gateway (T12). What leaves the process, as typed, delimited fields:
 *   - `message`: the shopper's PII-scrubbed, length-capped text, as untrusted data (P1, required:
 *     an instruction-like message is refused rather than neutralised);
 *   - `state`: enums and a budget BAND only. Never the exact budget, sizes, measurements, names,
 *     addresses, order history or ids (LLM02);
 *   - `recent_n`: earlier scrubbed user texts, only when the shopper enabled chat history.
 * The output is the strict enum schema of STYLIST_CHAT_INTENT. The model cannot return prose,
 * prices or ids (LLM05). The cache key is the normalised message plus the state fingerprint.
 */
export class GatewayChatIntent implements StylistChatIntentPort {
  constructor(private readonly gateway: LlmGateway) {}

  async parse(input: ChatIntentInput): Promise<ChatIntentOutcome> {
    const s = input.state;
    const stateView = {
      occasion: s.occasion,
      vibe: s.vibe,
      palette: s.palette,
      season: s.season,
      modest: s.modest,
      world: s.world,
      budget_band: chatBudgetBand(s.budgetPiastres),
      has_previous_outfit: s.lastOutfitIds.length > 0,
      rejected_count: s.rejectedItemIds.length,
      language: s.language,
    };
    const r = await this.gateway.run({
      prompt: STYLIST_CHAT_INTENT,
      userId: input.userId,
      fields: [
        { name: "message", value: input.message, dataClass: "P1", trust: "untrusted", required: true },
        { name: "state", value: canonicalJson(stateView), dataClass: "P0", trust: "trusted" },
        ...(input.localeHint === null ? [] : [{ name: "locale_hint", value: input.localeHint, dataClass: "P0" as const, trust: "trusted" as const }]),
        ...input.recentUserTexts.map((t, n) => ({ name: `recent_${n}`, value: t.slice(0, 300), dataClass: "P1" as const, trust: "untrusted" as const })),
      ],
      cacheKeyInput: { m: normalizeText(input.message), s: stateView, h: input.localeHint, r: input.recentUserTexts.map(normalizeText) },
      crossBorderConsent: false,
    });
    if (r.kind !== "ok") return { kind: "unavailable", reason: r.reason };
    const v = r.value;
    const intent: ParsedIntent = {
      intent: v.intent,
      language: v.language,
      ...(v.occasion !== undefined ? { occasion: v.occasion } : {}),
      ...(v.season !== undefined ? { season: v.season as Season } : {}),
      ...(v.modest !== undefined ? { modest: v.modest } : {}),
      ...(v.formality !== undefined ? { formality: v.formality } : {}),
      ...(v.vibe !== undefined ? { vibe: v.vibe } : {}),
      ...(v.budget_egp !== undefined ? { budgetEgp: v.budget_egp } : {}),
      ...(v.world !== undefined ? { world: v.world } : {}),
      ...(v.slot !== undefined ? { slot: v.slot } : {}),
      ...(v.clarify !== undefined ? { clarify: v.clarify } : {}),
      ...(v.refuse !== undefined ? { refuse: v.refuse } : {}),
    };
    return {
      kind: "ok",
      intent,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      promptHash: this.gateway.promptHash(STYLIST_CHAT_INTENT),
      cached: r.cached,
      neutralised: r.neutralisedFields.length > 0,
    };
  }
}

/**
 * Decorates the stylist's LLM port so that instruction-like seller text is a recorded signal
 * (LLM01). It scans the titles that are about to be sent as untrusted data and writes a counter
 * event (never the text). Behaviour is unchanged: prices, stock and ids still come from the
 * catalogue, and the gateway neutralises the field.
 */
export class InjectionSignalingLlm implements StylistLlmPort {
  constructor(
    private readonly inner: StylistLlmPort,
    private readonly sink: Pick<StylistChatStore, "emit">,
  ) {}

  parseIntent(input: Parameters<StylistLlmPort["parseIntent"]>[0]): ReturnType<StylistLlmPort["parseIntent"]> {
    return this.inner.parseIntent(input);
  }

  async rerank(input: Parameters<StylistLlmPort["rerank"]>[0]): ReturnType<StylistLlmPort["rerank"]> {
    let matches = 0;
    for (const i of input.items) if (detectInjection(i.title).flagged) matches++;
    if (matches > 0) {
      const ev: ChatEvent = { type: "stylist.injection_detected", userId: input.userId, source: "product_text", matches, sessionId: null };
      // A failed signal must never fail the shopper's request.
      await this.sink.emit([ev]).catch(() => undefined);
    }
    return this.inner.rerank(input);
  }
}
