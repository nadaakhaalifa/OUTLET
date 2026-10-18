import { detectInjection, scrubPii } from "../../llm-gateway";
import type { Slot } from "../domain/bridge";
import {
  ChatStateSchema,
  CHAT_OCCASIONS,
  CHAT_PALETTES,
  applyPalette,
  chipsFor,
  detectLanguage,
  egpCeil,
  initialChatState,
  parseRules,
  planTurn,
  reconcileIntent,
  renderReply,
  QUICK_ACTIONS,
  REFUSAL_CODE,
  SLOT_LABELS,
  type ChatLang,
  type ChatOccasion,
  type ChatPalette,
  type ChatState,
  type ChipOption,
  type ClarifyTopic,
  type ParsedIntent,
  type ReplyCode,
  type StoredBlock,
} from "../domain/chat";
import type { ChatEvent, ChatSessionRecord, ChatTurnRecord, StylistChatIntentPort, StylistChatStore } from "../domain/chat-ports";
import type { CandidateQuery, CandidateSourcePort, OutfitRecord, Scope, StylistCandidate, World } from "../domain/ports";
import { GenerateOutfits, type GenerateOutcome } from "./generate";
import { DAY_MS, FLAG_CHAT, FLAG_LLM, flagOn, startOfUtcDay, type StylistDeps } from "./shared";

export interface ChatConfig {
  /** Free fair-use limit of answered chat turns per UTC day (spec Quotas). */
  readonly dailyTurns: number;
  /** Longer input is truncated and the client is warned (spec Edge cases). */
  readonly maxInputChars: number;
  /** User texts handed to the model as context, only when history is on. */
  readonly recentTurns: number;
  /** Stored transcript text is erased after this long (spec Rules: 30 days). */
  readonly textTtlMs: number;
  /** Sessions kept per user in the list view. */
  readonly listLimit: number;
}

export const DEFAULT_CHAT_CONFIG: ChatConfig = {
  dailyTurns: 30,
  maxInputChars: 500,
  recentTurns: 3,
  textTtlMs: 30 * DAY_MS,
  listLimit: 20,
};

export interface ChatDeps {
  readonly d: StylistDeps;
  readonly chat: StylistChatStore;
  readonly intent: StylistChatIntentPort;
  readonly cfg: ChatConfig;
}

// ---- views ---------------------------------------------------------------------------------------

export interface RenderedItem {
  readonly itemId: string;
  readonly available: boolean;
  /** Current catalogue price; null when the item can no longer be read. Always from the database. */
  readonly currentPricePiastres: bigint | null;
  readonly priceChanged: boolean;
}

export type RenderedBlock =
  | { readonly type: "text"; readonly code: string; readonly text: string; readonly lang: ChatLang }
  | { readonly type: "outfits"; readonly outfits: readonly { readonly record: OutfitRecord; readonly items: readonly RenderedItem[] }[] }
  | { readonly type: "chips"; readonly topic: ClarifyTopic | "swap_slot"; readonly options: readonly ChipOption[] }
  | { readonly type: "quick_actions"; readonly options: readonly ChipOption[] };

export interface ChatTurnView {
  readonly sessionId: string;
  readonly turnId: string;
  readonly seq: number;
  readonly source: "llm" | "rules";
  readonly intent: string;
  readonly language: ChatLang;
  readonly blocks: readonly RenderedBlock[];
  readonly truncated: boolean;
  readonly remainingTurnsToday: number;
  readonly replay: boolean;
}

export interface SessionView {
  readonly session: ChatSessionRecord;
  readonly turns: readonly {
    readonly seq: number;
    readonly role: "user" | "assistant";
    readonly text: string | null;
    readonly source: "llm" | "rules" | null;
    readonly blocks: readonly RenderedBlock[];
    readonly createdAtMs: number;
  }[];
}

export type ChatAction =
  | { readonly type: "cheaper" }
  | { readonly type: "more_modest" }
  | { readonly type: "swap_item"; readonly itemId: string }
  | { readonly type: "scope"; readonly world: World; readonly storeIds: readonly string[] }
  | { readonly type: "chip"; readonly topic: "palette" | "occasion" | "budget" | "swap_slot"; readonly value: string };

export interface SendInput {
  readonly userId: string;
  readonly sessionId: string;
  readonly clientMessageId: string;
  readonly text: string | null;
  readonly action: ChatAction | null;
  readonly localeHint: ChatLang | null;
  readonly useRemainingBudget: boolean;
}

export type SendOutcome =
  | { readonly kind: "disabled" }
  | { readonly kind: "not_found" }
  | { readonly kind: "quota_exceeded"; readonly retryAfterMs: number; readonly limit: number }
  | { readonly kind: "generation_quota"; readonly retryAfterMs: number }
  | { readonly kind: "ok"; readonly view: ChatTurnView };

const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const CHIP_LOOKUP = (topic: ClarifyTopic | "swap_slot", ids: readonly string[]): ChipOption[] =>
  chipsFor(topic).filter((c) => ids.includes(c.id));

/** Filters rejected items and applies the (soft) palette on top of the catalogue port. Read-only. */
class ChatCandidateView implements CandidateSourcePort {
  constructor(
    private readonly inner: CandidateSourcePort,
    private readonly rejected: ReadonlySet<string>,
    private readonly palette: ChatPalette | null,
  ) {}
  async candidates(q: CandidateQuery): Promise<readonly StylistCandidate[]> {
    const all = await this.inner.candidates(q);
    return applyPalette(
      all.filter((c) => !this.rejected.has(c.itemId)),
      this.palette,
    );
  }
}

const isPalette = (v: string): v is ChatPalette => (CHAT_PALETTES as readonly string[]).includes(v);

export class StylistChat {
  constructor(private readonly c: ChatDeps) {}

  // ---- sessions -----------------------------------------------------------------------------------

  async createSession(input: {
    readonly userId: string;
    readonly localeHint: ChatLang | null;
    readonly scope: Scope | null;
  }): Promise<{ readonly kind: "disabled" } | { readonly kind: "ok"; readonly session: ChatSessionRecord }> {
    const { d, chat, cfg } = this.c;
    if (!(await flagOn(d.flags, FLAG_CHAT))) return { kind: "disabled" };
    const now = d.clock.nowMs();
    // Transcript text is kept 30 days at most; sweep this shopper's expired text on every new session.
    await chat.expireTexts(input.userId, now - cfg.textTtlMs).catch(() => 0);
    const historyEnabled = await chat.getHistoryEnabled(input.userId);
    const session: ChatSessionRecord = {
      id: d.ids.uuidV7(),
      userId: input.userId,
      state: initialChatState(input.localeHint ?? "ar", input.scope?.world ?? "everything", input.scope?.storeIds ?? []),
      historyEnabled,
      createdAtMs: now,
      updatedAtMs: now,
    };
    await chat.createSession(session);
    return { kind: "ok", session };
  }

  async getSession(userId: string, sessionId: string): Promise<SessionView | null> {
    const { d, chat, cfg } = this.c;
    const s = await chat.getSession(sessionId);
    if (s === null || s.userId !== userId) return null;
    await chat.expireTexts(userId, d.clock.nowMs() - cfg.textTtlMs).catch(() => 0);
    const turns = await chat.listTurns(sessionId, 200);
    const out: SessionView["turns"][number][] = [];
    for (const t of turns) {
      out.push({
        seq: t.seq,
        role: t.role,
        text: t.role === "user" ? t.text : null,
        source: t.source,
        // Every render re-reads outfits and re-validates price and stock (spec Edge cases).
        blocks: t.role === "assistant" ? await this.render(userId, t.blocks) : [],
        createdAtMs: t.createdAtMs,
      });
    }
    return { session: s, turns: out };
  }

  async listSessions(userId: string): Promise<readonly ChatSessionRecord[]> {
    return this.c.chat.listSessions(userId, this.c.cfg.listLimit);
  }

  async deleteSession(userId: string, sessionId: string): Promise<boolean> {
    const ev: ChatEvent = { type: "chat.session_deleted", userId, sessionId };
    return this.c.chat.deleteSession(sessionId, userId, [ev]);
  }

  async getHistoryEnabled(userId: string): Promise<boolean> {
    return this.c.chat.getHistoryEnabled(userId);
  }

  async setHistoryEnabled(userId: string, enabled: boolean): Promise<void> {
    await this.c.chat.setHistoryEnabled(userId, enabled, this.c.d.clock.nowMs(), [{ type: "stylist_chat.history_changed", userId, enabled }]);
  }

  // ---- one turn -----------------------------------------------------------------------------------

  async send(input: SendInput): Promise<SendOutcome> {
    const { d, chat, cfg } = this.c;
    if (!(await flagOn(d.flags, FLAG_CHAT))) return { kind: "disabled" };
    const session = await chat.getSession(input.sessionId);
    // Another shopper's session is indistinguishable from a missing one (BOLA).
    if (session === null || session.userId !== input.userId) return { kind: "not_found" };

    const prior = await chat.findAnswer(session.id, input.clientMessageId);
    if (prior !== null) return { kind: "ok", view: await this.viewOf(prior, session.userId, false, true) };

    const now = d.clock.nowMs();
    const day = dayKey(now);
    const used = await chat.turnsOnDay(input.userId, day);
    if (used >= cfg.dailyTurns) {
      return { kind: "quota_exceeded", retryAfterMs: startOfUtcDay(now) + DAY_MS - now, limit: cfg.dailyTurns };
    }

    const started = now;
    const historyEnabled = await chat.getHistoryEnabled(input.userId);
    const raw = input.text ?? "";
    const truncated = raw.length > cfg.maxInputChars;
    const scrubbed = scrubPii(raw.slice(0, cfg.maxInputChars)).text.trim();
    const events: ChatEvent[] = [];
    const tools: string[] = [];
    let state: ChatState = session.state;

    // ---- 1. classify the turn: structured action, injection guard, LLM, then rules ---------------
    let parsed: ParsedIntent;
    let source: "llm" | "rules" = "rules";
    let tokensIn = 0;
    let tokensOut = 0;
    let promptHash: string | null = null;
    let swapItemId: string | null = null;

    if (input.action !== null) {
      const a = this.fromAction(state, input.action, input.localeHint);
      parsed = a.parsed;
      state = a.state;
      swapItemId = a.swapItemId;
    } else {
      const injection = detectInjection(scrubbed);
      const rules = parseRules(scrubbed, input.localeHint);
      const hardRefusal = rules.intent === "refuse" && rules.refuse !== "non_fashion";
      if (injection.flagged) {
        parsed = { intent: "refuse", refuse: "injection", language: detectLanguage(scrubbed, input.localeHint) };
        events.push({ type: "stylist.injection_detected", userId: input.userId, source: "user_text", matches: injection.matches, sessionId: session.id });
      } else if (hardRefusal || scrubbed.length === 0) {
        // Deterministic safety classes (credit, medical, external sites, abuse) are never left to the model.
        parsed = rules;
      } else if (await flagOn(d.flags, FLAG_LLM)) {
        tools.push("classify_llm");
        const recent = historyEnabled ? await this.recentUserTexts(session.id) : [];
        let r = await this.c.intent.parse({ userId: input.userId, message: scrubbed, localeHint: input.localeHint, state, recentUserTexts: recent });
        if (r.kind === "unavailable" && r.reason === "invalid_output") {
          // One repair retry, then the rules parser (spec Failure handling).
          r = await this.c.intent.parse({ userId: input.userId, message: scrubbed, localeHint: input.localeHint, state, recentUserTexts: recent });
        }
        if (r.kind === "ok") {
          parsed = reconcileIntent(r.intent, scrubbed);
          source = "llm";
          tokensIn = r.tokensIn;
          tokensOut = r.tokensOut;
          promptHash = r.promptHash;
          if (r.neutralised) events.push({ type: "stylist.injection_detected", userId: input.userId, source: "user_text", matches: 1, sessionId: session.id });
        } else {
          parsed = rules;
        }
      } else {
        parsed = rules;
      }
      if (source === "rules") tools.push("classify_rules");
    }

    // ---- 2. plan and execute ------------------------------------------------------------------------
    const lastOutfit = state.lastOutfitIds[0] === undefined ? null : await d.store.getOutfit(state.lastOutfitIds[0]);
    const lastItems = lastOutfit !== null && lastOutfit.userId === input.userId ? lastOutfit.items.map((i) => ({ itemId: i.itemId, slot: i.slot })) : [];
    const plan = planTurn(state, parsed, { lastItems }, swapItemId);
    const lang = plan.state.language;
    const blocks: StoredBlock[] = [];
    let nextState: ChatState = plan.state;
    let intentLabel: string = parsed.intent;

    const text = (code: ReplyCode, params: Record<string, string> = {}): StoredBlock => ({ type: "text", code, params, lang });

    if (plan.kind === "refuse") {
      blocks.push(text(REFUSAL_CODE[plan.reason]));
      events.push({ type: "stylist_chat.refusal", userId: input.userId, sessionId: session.id, reason: plan.reason });
      intentLabel = "refuse";
    } else if (plan.kind === "clarify") {
      const code: ReplyCode = plan.topic === "palette" ? "clarify_palette" : plan.topic === "budget" ? "clarify_budget" : "clarify_occasion";
      blocks.push(text(code), { type: "chips", topic: plan.topic, optionIds: chipsFor(plan.topic).map((c) => c.id) });
      intentLabel = "clarify";
    } else if (plan.kind === "ask_swap_slot") {
      blocks.push(text("swap_which"), { type: "chips", topic: "swap_slot", optionIds: chipsFor("swap_slot").map((c) => c.id) });
      intentLabel = "swap_item";
    } else {
      tools.push("scope", "search", "size_label", "stock");
      if (plan.state.budgetPiastres !== null || input.useRemainingBudget) tools.push("budget_band");
      const deps: StylistDeps = {
        ...d,
        candidates: new ChatCandidateView(d.candidates, new Set(plan.state.rejectedItemIds), plan.state.palette),
      };
      const gen = await new GenerateOutfits(deps).execute({
        userId: input.userId,
        occasion: plan.state.occasion,
        season: plan.state.season,
        modest: plan.state.modest,
        formality: plan.state.formality,
        typedBudget: plan.state.budgetPiastres === null ? null : BigInt(plan.state.budgetPiastres),
        useRemainingBudget: input.useRemainingBudget,
        scope: { world: plan.state.world, storeIds: plan.state.storeIds },
        wishlistOnly: false,
        // The note is NOT forwarded: the chat classified the turn already, and free text never
        // reaches a second prompt.
        note: null,
      });
      if (gen.kind === "quota_exceeded") return { kind: "generation_quota", retryAfterMs: gen.retryAfterMs };
      const g = this.fromGeneration(gen, plan.why, lang);
      blocks.push(...g.blocks);
      if (g.outfits.length > 0) {
        nextState = {
          ...plan.state,
          lastOutfitIds: g.outfits.slice(0, 5).map((o) => o.id),
          lastTotalPiastres: (g.outfits[0] as OutfitRecord).totalPiastres.toString(),
        };
        tools.push("outfit_optimizer");
      }
    }

    // ---- 3. persist the exchange atomically with the fair-use counter ------------------------------
    const finished = d.clock.nowMs();
    events.push({
      type: "stylist_chat.turn",
      userId: input.userId,
      sessionId: session.id,
      intent: intentLabel,
      source,
      latencyMs: Math.max(0, finished - started),
      toolsUsed: [...new Set(tools)],
    });
    const userTurn: Omit<ChatTurnRecord, "seq"> = {
      id: d.ids.uuidV7(),
      sessionId: session.id,
      userId: input.userId,
      role: "user",
      clientMessageId: input.clientMessageId,
      // Text only with "save chat history" on, and only the scrubbed form.
      text: historyEnabled && scrubbed.length > 0 ? scrubbed : null,
      replyCode: null,
      blocks: [],
      intent: null,
      source: null,
      promptHash: null,
      tokensIn: 0,
      tokensOut: 0,
      toolCalls: [],
      createdAtMs: started,
    };
    const first = blocks[0];
    const assistantTurn: Omit<ChatTurnRecord, "seq"> = {
      id: d.ids.uuidV7(),
      sessionId: session.id,
      userId: input.userId,
      role: "assistant",
      clientMessageId: null,
      text: null,
      replyCode: first !== undefined && first.type === "text" ? first.code : null,
      blocks,
      intent: intentLabel,
      source,
      promptHash,
      tokensIn,
      tokensOut,
      toolCalls: [...new Set(tools)],
      createdAtMs: finished,
    };
    const stored = await chat.appendExchange({
      session: { ...session, state: ChatStateSchema.parse(nextState), historyEnabled, updatedAtMs: finished },
      userTurn,
      assistantTurn,
      day,
      dailyLimit: cfg.dailyTurns,
      events,
    });
    if (stored === "quota_exceeded") return { kind: "quota_exceeded", retryAfterMs: startOfUtcDay(now) + DAY_MS - now, limit: cfg.dailyTurns };
    if (stored === "duplicate") {
      const a = await chat.findAnswer(session.id, input.clientMessageId);
      if (a !== null) return { kind: "ok", view: await this.viewOf(a, session.userId, false, true) };
    }
    const seq = (await chat.listTurns(session.id, 1000)).find((t) => t.id === assistantTurn.id)?.seq ?? 0;
    const view = await this.viewOf({ ...assistantTurn, seq }, session.userId, truncated, false, used + 1);
    return { kind: "ok", view };
  }

  // ---- internals ---------------------------------------------------------------------------------

  private async recentUserTexts(sessionId: string): Promise<string[]> {
    const turns = await this.c.chat.listTurns(sessionId, 12);
    return turns
      .filter((t) => t.role === "user" && t.text !== null)
      .slice(-this.c.cfg.recentTurns)
      .map((t) => t.text as string);
  }

  private fromAction(
    state: ChatState,
    a: ChatAction,
    hint: ChatLang | null,
  ): { parsed: ParsedIntent; state: ChatState; swapItemId: string | null } {
    const language = hint ?? state.language;
    switch (a.type) {
      case "cheaper":
        return { parsed: { intent: "cheaper", language }, state, swapItemId: null };
      case "more_modest":
        return { parsed: { intent: "more_modest", modest: true, language }, state, swapItemId: null };
      case "swap_item":
        return { parsed: { intent: "swap_item", language }, state, swapItemId: a.itemId };
      case "scope":
        return {
          parsed: { intent: "change_scope", world: a.world, language },
          state: { ...state, storeIds: a.world === "my_stores" ? [...a.storeIds] : state.storeIds },
          swapItemId: null,
        };
      case "chip": {
        if (a.topic === "palette") {
          const palette = isPalette(a.value) ? a.value : null;
          return { parsed: { intent: "outfit", language }, state: { ...state, palette, clarificationsAsked: 0 }, swapItemId: null };
        }
        if (a.topic === "occasion") {
          const known = (CHAT_OCCASIONS as readonly string[]).includes(a.value) ? (a.value as ChatOccasion) : undefined;
          return { parsed: { intent: "outfit", ...(known !== undefined ? { occasion: known } : {}), language }, state, swapItemId: null };
        }
        if (a.topic === "budget") {
          const n = Number(a.value);
          const ok = Number.isInteger(n) && n >= 1 && n <= 1_000_000;
          return { parsed: { intent: "outfit", ...(ok ? { budgetEgp: n } : {}), language }, state, swapItemId: null };
        }
        const slot = a.value as Slot;
        return { parsed: { intent: "swap_item", slot, language }, state, swapItemId: null };
      }
    }
  }

  private fromGeneration(
    gen: GenerateOutcome,
    why: "outfit" | "cheaper" | "more_modest" | "change_scope" | "swap_item" | "refine",
    lang: ChatLang,
  ): { blocks: StoredBlock[]; outfits: readonly OutfitRecord[] } {
    const text = (code: ReplyCode, params: Record<string, string> = {}): StoredBlock => ({ type: "text", code, params, lang });
    const quick: StoredBlock = { type: "quick_actions", optionIds: QUICK_ACTIONS.map((q) => q.id) };
    if (gen.kind === "catalog_unavailable") return { blocks: [text("catalog_unavailable")], outfits: [] };
    if (gen.kind === "anchor_unavailable") return { blocks: [text("no_items_in_size"), quick], outfits: [] };
    if (gen.kind !== "ok") return { blocks: [text("catalog_unavailable")], outfits: [] };
    const outfits = gen.view.outfits;
    const best = outfits[0];
    if (best === undefined) {
      const code: ReplyCode = gen.view.explanation === "no_items_in_size" ? "no_items_in_size" : "no_items_in_scope";
      return { blocks: [text(code), quick], outfits: [] };
    }
    const budgetGap = best.missing.find((m) => m.reason === "budget");
    const sizeGap = best.missing.find((m) => m.reason === "no_item_in_size");
    let head: StoredBlock;
    if (budgetGap !== undefined && budgetGap.addPiastres !== null) {
      head = text("outfit_partial", { amount: egpCeil(budgetGap.addPiastres), slot: SLOT_LABELS[budgetGap.slot][lang] });
    } else if (sizeGap !== undefined) {
      head = text("no_items_in_size");
    } else {
      head = text(why === "swap_item" ? "swap_done" : "outfits_ready");
    }
    return { blocks: [head, { type: "outfits", outfitIds: outfits.map((o) => o.id) }, quick], outfits };
  }

  /** Re-reads outfits and re-validates price and stock for every outfit block (LLM09). */
  private async render(userId: string, blocks: readonly StoredBlock[]): Promise<RenderedBlock[]> {
    const out: RenderedBlock[] = [];
    for (const b of blocks) {
      if (b.type === "text") {
        out.push({ type: "text", code: b.code, lang: b.lang, text: renderReply(b.code as ReplyCode, b.lang, b.params) });
      } else if (b.type === "chips") {
        out.push({ type: "chips", topic: b.topic, options: CHIP_LOOKUP(b.topic, b.optionIds) });
      } else if (b.type === "quick_actions") {
        out.push({ type: "quick_actions", options: QUICK_ACTIONS.filter((q) => b.optionIds.includes(q.id)) });
      } else {
        const records: OutfitRecord[] = [];
        for (const id of b.outfitIds) {
          const o = await this.c.d.store.getOutfit(id);
          if (o !== null && o.userId === userId) records.push(o);
        }
        const itemIds = [...new Set(records.flatMap((r) => r.items.map((i) => i.itemId)))];
        const live = itemIds.length === 0 ? new Map() : await this.c.d.live.current(itemIds).catch(() => new Map());
        out.push({
          type: "outfits",
          outfits: records.map((record) => ({
            record,
            items: record.items.map((i) => {
              const l = live.get(i.itemId);
              return {
                itemId: i.itemId,
                available: l !== undefined && l.inStockInSize,
                currentPricePiastres: l === undefined ? null : l.pricePiastres,
                priceChanged: l !== undefined && l.pricePiastres !== i.pricePiastres,
              };
            }),
          })),
        });
      }
    }
    return out;
  }

  private async viewOf(
    t: Omit<ChatTurnRecord, "seq"> & { readonly seq?: number },
    userId: string,
    truncated: boolean,
    replay: boolean,
    usedToday?: number,
  ): Promise<ChatTurnView> {
    const used = usedToday ?? (await this.c.chat.turnsOnDay(userId, dayKey(this.c.d.clock.nowMs())));
    const firstText = t.blocks.find((b) => b.type === "text");
    return {
      sessionId: t.sessionId,
      turnId: t.id,
      seq: t.seq ?? 0,
      source: t.source ?? "rules",
      intent: t.intent ?? "clarify",
      language: firstText !== undefined && firstText.type === "text" ? firstText.lang : "ar",
      blocks: await this.render(userId, t.blocks),
      truncated,
      remainingTurnsToday: Math.max(0, this.c.cfg.dailyTurns - used),
      replay,
    };
  }
}
