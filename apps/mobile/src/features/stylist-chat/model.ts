/**
 * Stylist chat (spec P3-07). The server returns only catalogue text, chips and outfit ids resolved to catalogue
 * rows: this model never produces prices, stock or ids. Money is integer piastres (bigint). Pure model, port, fake.
 */
import { AiFailure, type AiFailureReason } from "../ai-failure";
import { FIXTURE_OUTFITS, type Outfit } from "../stylist/model";

export type ChatLang = "ar" | "en";

/** Server cap on one message (StylistChatMessage.text maxLength). */
export const MAX_CHAT_INPUT = 2000;
/** Below this many remaining turns the quota is shown (honest, server-derived; never a countdown for pressure). */
export const QUOTA_HINT_AT = 5;

export interface ChatOption {
  readonly id: string;
  readonly labelAr: string;
  readonly labelEn: string;
}

export type ChipTopic = "palette" | "occasion" | "budget" | "swap_slot";

export interface LiveItem {
  readonly available: boolean;
  /** Current catalogue price; null when the item could not be re-read. */
  readonly currentPrice: bigint | null;
  readonly priceChanged: boolean;
}

export interface ChatOutfit {
  readonly outfit: Outfit;
  readonly complete: boolean;
  readonly live: Readonly<Record<string, LiveItem>>;
}

export type ChatBlock =
  | { readonly kind: "text"; readonly code: string; readonly text: string; readonly refusal: boolean }
  | { readonly kind: "outfits"; readonly outfits: readonly ChatOutfit[] }
  | { readonly kind: "chips"; readonly topic: ChipTopic; readonly options: readonly ChatOption[] }
  | { readonly kind: "quick"; readonly options: readonly ChatOption[] };

export type ChatSource = "llm" | "rules";

export interface ChatTurn {
  readonly turnId: string;
  readonly seq: number;
  readonly source: ChatSource;
  readonly intent: string;
  readonly blocks: readonly ChatBlock[];
  readonly truncated: boolean;
  /** Turns left today (server fair use); null when the server did not say. */
  readonly remainingToday: number | null;
}

export interface ChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  /** Null for assistant messages (reply text lives in blocks) and for user text not stored (history off). */
  readonly text: string | null;
  readonly blocks: readonly ChatBlock[];
  readonly source: ChatSource | null;
}

export interface ChatSession {
  readonly id: string;
  readonly language: ChatLang;
  readonly historyEnabled: boolean;
  readonly updatedAtMs: number;
}

export interface ChatAction {
  readonly type: "cheaper" | "more_modest" | "swap_item" | "scope" | "chip";
  readonly world?: "local" | "global" | "everything" | "my_stores";
  readonly topic?: "palette" | "occasion" | "budget" | "swap_slot";
  readonly value?: string;
}

export type ChatInput = { readonly text: string } | { readonly action: ChatAction };

export interface ChatSettings {
  readonly historyEnabled: boolean;
}

export interface ChatPort {
  listSessions(): Promise<readonly ChatSession[]>;
  createSession(lang: ChatLang): Promise<ChatSession>;
  loadSession(id: string): Promise<{ readonly session: ChatSession; readonly messages: readonly ChatMessage[] }>;
  send(sessionId: string, input: ChatInput, lang: ChatLang): Promise<ChatTurn>;
  deleteSession(id: string): Promise<void>;
  getSettings(): Promise<ChatSettings>;
  setHistoryEnabled(enabled: boolean): Promise<ChatSettings>;
}

/* ---- pure logic ---- */

export function isRefusalCode(code: string): boolean {
  return code.startsWith("refuse_");
}

export function optionLabel(o: ChatOption, lang: ChatLang): string {
  return lang === "en" ? o.labelEn : o.labelAr;
}

const QUICK: Readonly<Record<string, ChatAction>> = {
  cheaper: { type: "cheaper" },
  more_modest: { type: "more_modest" },
  swap_item: { type: "swap_item" },
  scope_everything: { type: "scope", world: "everything" },
};

/** Maps a tapped chip or quick action to the wire action; null for an id the app does not know (never guessed). */
export function actionForOption(kind: "chip" | "quick", optionId: string, topic?: ChipTopic): ChatAction | null {
  if (kind === "quick") return QUICK[optionId] ?? null;
  if (topic === undefined || !/^[a-z0-9_]{1,40}$/.test(optionId)) return null;
  return { type: "chip", topic, value: optionId };
}

export type InputCheck = { readonly ok: true; readonly text: string; readonly truncated: boolean } | { readonly ok: false };

/** Trims and caps the message; empty input is not sent. */
export function checkInput(raw: string): InputCheck {
  const t = raw.trim();
  if (t === "") return { ok: false };
  const chars = [...t];
  if (chars.length <= MAX_CHAT_INPUT) return { ok: true, text: t, truncated: false };
  return { ok: true, text: chars.slice(0, MAX_CHAT_INPUT).join(""), truncated: true };
}

/** Quota hint to show: only when few turns remain. */
export function quotaHint(remaining: number | null): number | null {
  return remaining !== null && remaining <= QUOTA_HINT_AT ? Math.max(0, remaining) : null;
}

/** What a chat outfit shows: live total (catalogue price now), items that cannot be added, price changes. */
export interface ChatOutfitView {
  readonly total: bigint;
  readonly unavailable: readonly string[];
  readonly changed: readonly string[];
  readonly addable: boolean;
}

export function chatOutfitView(o: ChatOutfit): ChatOutfitView {
  let total = 0n;
  const unavailable: string[] = [];
  const changed: string[] = [];
  for (const i of o.outfit.items) {
    const l = o.live[i.skuId];
    if (l !== undefined && !l.available) {
      unavailable.push(i.skuId);
      continue;
    }
    total += l?.currentPrice ?? i.unitPrice;
    if (l?.priceChanged === true) changed.push(i.skuId);
  }
  return { total, unavailable, changed, addable: o.outfit.items.length > 0 && unavailable.length < o.outfit.items.length };
}

export type FailureTone = "info" | "warning" | "error";
export interface FailureView {
  readonly tone: FailureTone;
  /** True when the structured (non-chat) stylist is offered as the next action. */
  readonly offerStructured: boolean;
  readonly retry: boolean;
}

export function failureView(reason: AiFailureReason): FailureView {
  switch (reason) {
    case "quota":
      return { tone: "info", offerStructured: true, retry: false };
    case "disabled":
      return { tone: "info", offerStructured: true, retry: false };
    case "rateLimited":
      return { tone: "warning", offerStructured: false, retry: true };
    case "offline":
      return { tone: "warning", offerStructured: false, retry: true };
    default:
      return { tone: "error", offerStructured: true, retry: true };
  }
}

export type HistoryStep = "apply" | "confirmErase";
/** Turning history off with saved chats asks first (erase them too, or keep). Turning on never needs it. */
export function historyStep(currentlyEnabled: boolean, wantEnabled: boolean, savedSessions: number): HistoryStep {
  return currentlyEnabled && !wantEnabled && savedSessions > 0 ? "confirmErase" : "apply";
}

/** Deletes every session one by one (no bulk operation exists). Failures are counted, never hidden. */
export async function eraseAll(port: Pick<ChatPort, "deleteSession">, sessions: readonly ChatSession[]): Promise<{ readonly deleted: number; readonly failed: number }> {
  let deleted = 0;
  let failed = 0;
  for (const s of sessions) {
    try {
      await port.deleteSession(s.id);
      deleted += 1;
    } catch {
      failed += 1;
    }
  }
  return { deleted, failed };
}

/** Newest first. */
export function sortSessions(sessions: readonly ChatSession[]): readonly ChatSession[] {
  return [...sessions].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

export function appendMessages(list: readonly ChatMessage[], ...next: ChatMessage[]): readonly ChatMessage[] {
  return [...list, ...next];
}

export function turnToMessage(t: ChatTurn): ChatMessage {
  return { id: t.turnId, role: "assistant", text: null, blocks: t.blocks, source: t.source };
}

/* ---- in-memory fake (development and tests only; synthetic data) ---- */

const FAKE_CHIPS: readonly ChatOption[] = [
  { id: "wedding_guest", labelAr: "فرح", labelEn: "Wedding guest" },
  { id: "work", labelAr: "شغل", labelEn: "Work" },
  { id: "date", labelAr: "خروجة", labelEn: "Date" },
];
const FAKE_QUICK: readonly ChatOption[] = [
  { id: "cheaper", labelAr: "أرخص", labelEn: "Cheaper" },
  { id: "more_modest", labelAr: "أكثر احتشامًا", labelEn: "More modest" },
  { id: "swap_item", labelAr: "غيّر قطعة", labelEn: "Swap an item" },
  { id: "scope_everything", labelAr: "كل المتاجر", labelEn: "All stores" },
];

const REFUSE = /loan|credit card|قرض|تمويل|ignore previous|instructions/i;

export class InMemoryChatPort implements ChatPort {
  private readonly sessions = new Map<string, { session: ChatSession; messages: ChatMessage[] }>();
  private history = false;
  private used = 0;
  private n = 0;
  constructor(
    private readonly dailyTurns = 30,
    private readonly source: ChatSource = "llm",
    private failure: AiFailureReason | null = null,
    private readonly now: () => number = () => Date.now(),
  ) {}
  setFailure(f: AiFailureReason | null): void {
    this.failure = f;
  }
  private check(): void {
    if (this.failure !== null) throw new AiFailure(this.failure);
  }
  async listSessions(): Promise<readonly ChatSession[]> {
    this.check();
    return sortSessions([...this.sessions.values()].map((s) => s.session));
  }
  async createSession(lang: ChatLang): Promise<ChatSession> {
    this.check();
    this.n += 1;
    const session: ChatSession = { id: `chat-${this.n}`, language: lang, historyEnabled: this.history, updatedAtMs: this.now() };
    this.sessions.set(session.id, { session, messages: [] });
    return session;
  }
  async loadSession(id: string): Promise<{ session: ChatSession; messages: readonly ChatMessage[] }> {
    this.check();
    const s = this.sessions.get(id);
    if (s === undefined) throw new AiFailure("notFound");
    return { session: s.session, messages: s.messages };
  }
  async send(sessionId: string, input: ChatInput, lang: ChatLang): Promise<ChatTurn> {
    this.check();
    const s = this.sessions.get(sessionId);
    if (s === undefined) throw new AiFailure("notFound");
    if (this.used >= this.dailyTurns) throw new AiFailure("quota");
    this.used += 1;
    const text = "text" in input ? input.text : "";
    const t = (ar: string, en: string): string => (lang === "en" ? en : ar);
    let blocks: ChatBlock[];
    if ("text" in input && REFUSE.test(text)) {
      blocks = [{ kind: "text", code: "refuse_financial", refusal: true, text: t("مش بقدّم نصايح تمويل. أقدر أساعدك تلاقي لبس في ميزانيتك.", "I do not give credit advice. I can help you find outfits within your budget.") }];
    } else if ("text" in input && text.trim().length < 4) {
      blocks = [
        { kind: "text", code: "clarify_occasion", refusal: false, text: t("لأي مناسبة؟", "Which occasion?") },
        { kind: "chips", topic: "occasion", options: FAKE_CHIPS },
      ];
    } else {
      blocks = [
        { kind: "text", code: "outfits_ready", refusal: false, text: t("دي اقتراحات ليكي.", "Here are some suggestions.") },
        { kind: "outfits", outfits: FIXTURE_OUTFITS.map((outfit) => ({ outfit, complete: outfit.missing.length === 0, live: {} })) },
        { kind: "quick", options: FAKE_QUICK },
      ];
    }
    const turn: ChatTurn = {
      turnId: `turn-${this.used}`,
      seq: s.messages.length + 1,
      source: this.source,
      intent: "outfit",
      blocks,
      truncated: false,
      remainingToday: Math.max(0, this.dailyTurns - this.used),
    };
    const userMsg: ChatMessage = { id: `u-${this.used}`, role: "user", text: this.history && "text" in input ? text : null, blocks: [], source: null };
    s.messages.push(userMsg, turnToMessage(turn));
    s.session = { ...s.session, updatedAtMs: this.now() };
    return turn;
  }
  async deleteSession(id: string): Promise<void> {
    this.check();
    if (!this.sessions.delete(id)) throw new AiFailure("notFound");
  }
  async getSettings(): Promise<ChatSettings> {
    this.check();
    return { historyEnabled: this.history };
  }
  async setHistoryEnabled(enabled: boolean): Promise<ChatSettings> {
    this.check();
    this.history = enabled;
    return { historyEnabled: enabled };
  }
}
