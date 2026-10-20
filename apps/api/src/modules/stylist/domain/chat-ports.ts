import type { ChatLang, ChatState, ParsedIntent, StoredBlock } from "./chat";

// ---- the intent port (adapter wraps llm-gateway) -------------------------------------------------

export interface ChatIntentInput {
  readonly userId: string;
  /** PII-scrubbed, length-capped shopper message. Untrusted data (LLM01). */
  readonly message: string;
  readonly localeHint: ChatLang | null;
  readonly state: ChatState;
  /** Previous scrubbed user messages, only when "save chat history" is on. Empty otherwise. */
  readonly recentUserTexts: readonly string[];
}

export type ChatIntentOutcome =
  | {
      readonly kind: "ok";
      readonly intent: ParsedIntent;
      readonly tokensIn: number;
      readonly tokensOut: number;
      readonly promptHash: string;
      readonly cached: boolean;
      /** The gateway neutralised instruction-like text in a field (LLM01 signal). */
      readonly neutralised: boolean;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

/** Everything the chat asks of an LLM. The default binding is `NullChatIntent` (rules only). */
export interface StylistChatIntentPort {
  parse(input: ChatIntentInput): Promise<ChatIntentOutcome>;
}

// ---- persistence -----------------------------------------------------------------------------------

export interface ChatSessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly state: ChatState;
  readonly historyEnabled: boolean;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface ChatTurnRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly seq: number;
  readonly role: "user" | "assistant";
  /** Idempotency key of the shopper message, on user turns only. */
  readonly clientMessageId: string | null;
  /** Scrubbed shopper text, only when history is on. Always null on assistant turns. */
  readonly text: string | null;
  readonly replyCode: string | null;
  readonly blocks: readonly StoredBlock[];
  readonly intent: string | null;
  readonly source: "llm" | "rules" | null;
  readonly promptHash: string | null;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly toolCalls: readonly string[];
  readonly createdAtMs: number;
}

/** Outbox payloads carry ids, enums and counters. Never message text or item titles. */
export type ChatEvent =
  | {
      readonly type: "stylist_chat.turn";
      readonly userId: string;
      readonly sessionId: string;
      readonly intent: string;
      readonly source: "llm" | "rules";
      readonly latencyMs: number;
      readonly toolsUsed: readonly string[];
    }
  | { readonly type: "stylist_chat.refusal"; readonly userId: string; readonly sessionId: string; readonly reason: string }
  | { readonly type: "stylist.injection_detected"; readonly userId: string; readonly source: "user_text" | "product_text"; readonly matches: number; readonly sessionId: string | null }
  | { readonly type: "chat.session_deleted"; readonly userId: string; readonly sessionId: string }
  | { readonly type: "stylist_chat.history_changed"; readonly userId: string; readonly enabled: boolean };

export interface AppendExchange {
  readonly session: ChatSessionRecord;
  readonly userTurn: Omit<ChatTurnRecord, "seq">;
  readonly assistantTurn: Omit<ChatTurnRecord, "seq">;
  /** UTC day (YYYY-MM-DD) and the daily turn limit the counter must respect. */
  readonly day: string;
  readonly dailyLimit: number;
  readonly events: readonly ChatEvent[];
}

export interface StylistChatStore {
  createSession(s: ChatSessionRecord): Promise<void>;
  getSession(id: string): Promise<ChatSessionRecord | null>;
  /** Newest first. */
  listSessions(userId: string, limit: number): Promise<readonly ChatSessionRecord[]>;
  /**
   * Atomically: next seq numbers, both turns, the session state and `updated_at`, the outbox
   * events and the daily counter. "duplicate" when the client message id was already stored (the
   * unique index is the idempotency point); "quota_exceeded" when the counter is at the limit.
   */
  appendExchange(x: AppendExchange): Promise<"stored" | "duplicate" | "quota_exceeded">;
  /** The assistant turn that answered `clientMessageId`, if any. */
  findAnswer(sessionId: string, clientMessageId: string): Promise<ChatTurnRecord | null>;
  /** Oldest first. */
  listTurns(sessionId: string, limit: number): Promise<readonly ChatTurnRecord[]>;
  turnsOnDay(userId: string, day: string): Promise<number>;
  /** Hard delete: the session, its turns. Returns false when it does not exist or is not the user's. */
  deleteSession(id: string, userId: string, events: readonly ChatEvent[]): Promise<boolean>;
  getHistoryEnabled(userId: string): Promise<boolean>;
  /** Turning history off also nullifies every stored text of the user in the same transaction. */
  setHistoryEnabled(userId: string, enabled: boolean, atMs: number, events: readonly ChatEvent[]): Promise<void>;
  /** Nullifies turn texts older than `beforeMs` (spec: transcripts 30 days). Returns rows changed. */
  expireTexts(userId: string, beforeMs: number): Promise<number>;
  /** Signals that are not tied to an exchange (product-text injection from the stylist pipeline). */
  emit(events: readonly ChatEvent[]): Promise<void>;
  /** Account erasure or history clear: sessions, turns, settings, quota rows. */
  eraseForUser(userId: string): Promise<void>;
}
