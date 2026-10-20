import type { ChatState } from "../domain/chat";
import type {
  AppendExchange,
  ChatEvent,
  ChatIntentInput,
  ChatIntentOutcome,
  ChatSessionRecord,
  ChatTurnRecord,
  StylistChatIntentPort,
  StylistChatStore,
} from "../domain/chat-ports";
import type { ParsedIntent } from "../domain/chat";

export class InMemoryChatStore implements StylistChatStore {
  readonly events: ChatEvent[] = [];
  private readonly sessions = new Map<string, ChatSessionRecord>();
  private readonly turns = new Map<string, ChatTurnRecord[]>();
  private readonly quota = new Map<string, number>();
  private readonly history = new Map<string, boolean>();

  async createSession(s: ChatSessionRecord): Promise<void> {
    if (this.sessions.has(s.id)) throw new Error("duplicate session");
    this.sessions.set(s.id, s);
    this.turns.set(s.id, []);
  }
  async getSession(id: string): Promise<ChatSessionRecord | null> {
    return this.sessions.get(id) ?? null;
  }
  async listSessions(userId: string, limit: number): Promise<readonly ChatSessionRecord[]> {
    return [...this.sessions.values()]
      .filter((s) => s.userId === userId)
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs || (a.id < b.id ? 1 : -1))
      .slice(0, limit);
  }
  async appendExchange(x: AppendExchange): Promise<"stored" | "duplicate" | "quota_exceeded"> {
    const list = this.turns.get(x.session.id);
    if (list === undefined) throw new Error("no session");
    if (x.userTurn.clientMessageId !== null && list.some((t) => t.clientMessageId === x.userTurn.clientMessageId)) return "duplicate";
    const qk = `${x.session.userId}|${x.day}`;
    const used = this.quota.get(qk) ?? 0;
    if (used >= x.dailyLimit) return "quota_exceeded";
    this.quota.set(qk, used + 1);
    const seq = list.length;
    list.push({ ...x.userTurn, seq: seq + 1 }, { ...x.assistantTurn, seq: seq + 2 });
    this.sessions.set(x.session.id, x.session);
    this.events.push(...x.events);
    return "stored";
  }
  async findAnswer(sessionId: string, clientMessageId: string): Promise<ChatTurnRecord | null> {
    const list = this.turns.get(sessionId) ?? [];
    const u = list.find((t) => t.clientMessageId === clientMessageId);
    if (u === undefined) return null;
    return list.find((t) => t.seq === u.seq + 1 && t.role === "assistant") ?? null;
  }
  async listTurns(sessionId: string, limit: number): Promise<readonly ChatTurnRecord[]> {
    return (this.turns.get(sessionId) ?? []).slice(0, limit);
  }
  async turnsOnDay(userId: string, day: string): Promise<number> {
    return this.quota.get(`${userId}|${day}`) ?? 0;
  }
  async deleteSession(id: string, userId: string, events: readonly ChatEvent[]): Promise<boolean> {
    const s = this.sessions.get(id);
    if (s === undefined || s.userId !== userId) return false;
    this.sessions.delete(id);
    this.turns.delete(id);
    this.events.push(...events);
    return true;
  }
  async getHistoryEnabled(userId: string): Promise<boolean> {
    return this.history.get(userId) ?? false;
  }
  async setHistoryEnabled(userId: string, enabled: boolean, _atMs: number, events: readonly ChatEvent[]): Promise<void> {
    this.history.set(userId, enabled);
    if (!enabled) {
      for (const [sid, list] of this.turns) {
        if (this.sessions.get(sid)?.userId === userId) this.turns.set(sid, list.map((t) => ({ ...t, text: null })));
      }
    }
    this.events.push(...events);
  }
  async expireTexts(userId: string, beforeMs: number): Promise<number> {
    let n = 0;
    for (const [sid, list] of this.turns) {
      if (this.sessions.get(sid)?.userId !== userId) continue;
      this.turns.set(
        sid,
        list.map((t) => {
          if (t.text !== null && t.createdAtMs < beforeMs) {
            n++;
            return { ...t, text: null };
          }
          return t;
        }),
      );
    }
    return n;
  }
  async emit(events: readonly ChatEvent[]): Promise<void> {
    this.events.push(...events);
  }
  async eraseForUser(userId: string): Promise<void> {
    for (const [id, s] of this.sessions) {
      if (s.userId === userId) {
        this.sessions.delete(id);
        this.turns.delete(id);
      }
    }
    for (const k of this.quota.keys()) if (k.startsWith(`${userId}|`)) this.quota.delete(k);
    this.history.delete(userId);
  }
  /** Test helper: every stored turn text of a user. */
  texts(userId: string): string[] {
    const out: string[] = [];
    for (const [sid, list] of this.turns) if (this.sessions.get(sid)?.userId === userId) for (const t of list) if (t.text !== null) out.push(t.text);
    return out;
  }
}

/** Default binding: no model, so every chat turn is classified by the rules parser. */
export class NullChatIntent implements StylistChatIntentPort {
  async parse(): Promise<ChatIntentOutcome> {
    return { kind: "unavailable", reason: "no_provider" };
  }
}

/** Scriptable intent port for tests and dev. */
export class FakeChatIntent implements StylistChatIntentPort {
  readonly calls: ChatIntentInput[] = [];
  respond: ((i: ChatIntentInput) => ParsedIntent | null) | null = null;
  async parse(i: ChatIntentInput): Promise<ChatIntentOutcome> {
    this.calls.push(i);
    const r = this.respond === null ? null : this.respond(i);
    if (r === null) return { kind: "unavailable", reason: "provider_error" };
    return { kind: "ok", intent: r, tokensIn: 30, tokensOut: 20, promptHash: "a".repeat(64), cached: false, neutralised: false };
  }
}

export type { ChatState };
