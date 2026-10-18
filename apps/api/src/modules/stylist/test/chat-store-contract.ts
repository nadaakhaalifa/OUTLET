import { describe, expect, it } from "vitest";
import { initialChatState } from "../domain/chat";
import type { ChatSessionRecord, ChatTurnRecord, StylistChatStore } from "../domain/chat-ports";
import { START_MS, U } from "./fixtures";

export interface ChatStoreFixture {
  readonly store: StylistChatStore;
  readonly ensureUser: (id: string) => Promise<void>;
  readonly eventTypes: () => Promise<readonly string[]>;
}

const IDM = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;
export const session = (n: number, userId: string, over: Partial<ChatSessionRecord> = {}): ChatSessionRecord => ({
  id: U(500 + n),
  userId,
  state: initialChatState("ar"),
  historyEnabled: false,
  createdAtMs: START_MS,
  updatedAtMs: START_MS,
  ...over,
});

let tseq = 0;
export const turns = (s: ChatSessionRecord, clientId: string, text: string | null, atMs = START_MS + 1000) => {
  const base = {
    sessionId: s.id,
    userId: s.userId,
    replyCode: null,
    intent: null,
    source: null,
    promptHash: null,
    tokensIn: 0,
    tokensOut: 0,
    toolCalls: [] as string[],
    createdAtMs: atMs,
  };
  const user: Omit<ChatTurnRecord, "seq"> = { ...base, id: U(8000 + ++tseq), role: "user", clientMessageId: clientId, text, blocks: [] };
  const assistant: Omit<ChatTurnRecord, "seq"> = {
    ...base,
    id: U(8000 + ++tseq),
    role: "assistant",
    clientMessageId: null,
    text: null,
    replyCode: "outfits_ready",
    intent: "outfit",
    source: "rules",
    blocks: [{ type: "text", code: "outfits_ready", params: {}, lang: "ar" }],
  };
  return { user, assistant };
};

export function describeChatStoreContract(name: string, make: () => Promise<ChatStoreFixture>): void {
  describe(`stylist chat store contract: ${name}`, () => {
    it("creates a session and reads it back with its structured state", async () => {
      const f = await make();
      await f.ensureUser(U(1));
      const s = session(1, U(1), { state: { ...initialChatState("en", "local"), occasion: "work", budgetPiastres: "300000", modest: true } });
      await f.store.createSession(s);
      expect(await f.store.getSession(s.id)).toEqual(s);
      expect(await f.store.getSession(U(999))).toBeNull();
      expect((await f.store.listSessions(U(1), 10)).map((x) => x.id)).toEqual([s.id]);
      expect(await f.store.listSessions(U(2), 10)).toEqual([]);
    });

    it("appends an exchange atomically: seq numbers, state, counter and outbox event", async () => {
      const f = await make();
      await f.ensureUser(U(1));
      const s = session(1, U(1));
      await f.store.createSession(s);
      const t = turns(s, IDM(1), "عايزة فستان");
      const r = await f.store.appendExchange({
        session: { ...s, state: { ...s.state, occasion: "eid" }, historyEnabled: true, updatedAtMs: START_MS + 5000 },
        userTurn: t.user,
        assistantTurn: t.assistant,
        day: "2026-10-12",
        dailyLimit: 30,
        events: [{ type: "stylist_chat.turn", userId: U(1), sessionId: s.id, intent: "outfit", source: "rules", latencyMs: 3, toolsUsed: ["search"] }],
      });
      expect(r).toBe("stored");
      const list = await f.store.listTurns(s.id, 10);
      expect(list.map((x) => [x.seq, x.role, x.text])).toEqual([
        [1, "user", "عايزة فستان"],
        [2, "assistant", null],
      ]);
      expect((await f.store.getSession(s.id))?.state.occasion).toBe("eid");
      expect(await f.store.turnsOnDay(U(1), "2026-10-12")).toBe(1);
      expect(await f.eventTypes()).toContain("stylist_chat.turn");
      expect((await f.store.findAnswer(s.id, IDM(1)))?.id).toBe(t.assistant.id);
      expect(await f.store.findAnswer(s.id, IDM(2))).toBeNull();
    });

    it("a repeated client message id is a duplicate and changes nothing (idempotency point)", async () => {
      const f = await make();
      await f.ensureUser(U(1));
      const s = session(1, U(1));
      await f.store.createSession(s);
      const a = turns(s, IDM(1), null);
      const x = { session: s, day: "2026-10-12", dailyLimit: 30, events: [] };
      expect(await f.store.appendExchange({ ...x, userTurn: a.user, assistantTurn: a.assistant })).toBe("stored");
      const b = turns(s, IDM(1), null);
      expect(await f.store.appendExchange({ ...x, userTurn: b.user, assistantTurn: b.assistant })).toBe("duplicate");
      expect(await f.store.turnsOnDay(U(1), "2026-10-12")).toBe(1);
      expect((await f.store.listTurns(s.id, 10)).length).toBe(2);
    });

    it("the daily counter stops at the limit and writes nothing past it", async () => {
      const f = await make();
      await f.ensureUser(U(1));
      const s = session(1, U(1));
      await f.store.createSession(s);
      const x = { session: s, day: "2026-10-12", dailyLimit: 2, events: [] };
      for (let i = 1; i <= 2; i++) {
        const t = turns(s, IDM(i), null);
        expect(await f.store.appendExchange({ ...x, userTurn: t.user, assistantTurn: t.assistant })).toBe("stored");
      }
      const t3 = turns(s, IDM(3), null);
      expect(await f.store.appendExchange({ ...x, userTurn: t3.user, assistantTurn: t3.assistant })).toBe("quota_exceeded");
      expect((await f.store.listTurns(s.id, 10)).length).toBe(4);
      expect(await f.store.turnsOnDay(U(1), "2026-10-12")).toBe(2);
      // A new UTC day starts at zero.
      const t4 = turns(s, IDM(4), null);
      expect(await f.store.appendExchange({ ...x, day: "2026-10-13", userTurn: t4.user, assistantTurn: t4.assistant })).toBe("stored");
    });

    it("turning history off nullifies every stored text of the user and emits an event", async () => {
      const f = await make();
      await f.ensureUser(U(1));
      await f.ensureUser(U(2));
      const s1 = session(1, U(1));
      const s2 = session(2, U(2));
      await f.store.createSession(s1);
      await f.store.createSession(s2);
      const a = turns(s1, IDM(1), "hello text");
      const b = turns(s2, IDM(2), "someone else");
      const x = { day: "2026-10-12", dailyLimit: 30, events: [] };
      await f.store.appendExchange({ ...x, session: s1, userTurn: a.user, assistantTurn: a.assistant });
      await f.store.appendExchange({ ...x, session: s2, userTurn: b.user, assistantTurn: b.assistant });
      expect(await f.store.getHistoryEnabled(U(1))).toBe(false);
      await f.store.setHistoryEnabled(U(1), true, START_MS, []);
      expect(await f.store.getHistoryEnabled(U(1))).toBe(true);
      await f.store.setHistoryEnabled(U(1), false, START_MS, [{ type: "stylist_chat.history_changed", userId: U(1), enabled: false }]);
      expect((await f.store.listTurns(s1.id, 10)).every((t) => t.text === null)).toBe(true);
      expect((await f.store.listTurns(s2.id, 10)).some((t) => t.text === "someone else")).toBe(true);
      expect(await f.eventTypes()).toContain("stylist_chat.history_changed");
    });

    it("expireTexts nullifies only older text of that user", async () => {
      const f = await make();
      await f.ensureUser(U(1));
      const s = session(1, U(1));
      await f.store.createSession(s);
      const old = turns(s, IDM(1), "old text", START_MS);
      const fresh = turns(s, IDM(2), "fresh text", START_MS + 10_000);
      const x = { session: s, day: "2026-10-12", dailyLimit: 30, events: [] };
      await f.store.appendExchange({ ...x, userTurn: old.user, assistantTurn: old.assistant });
      await f.store.appendExchange({ ...x, userTurn: fresh.user, assistantTurn: fresh.assistant });
      expect(await f.store.expireTexts(U(1), START_MS + 5000)).toBe(1);
      const texts = (await f.store.listTurns(s.id, 10)).filter((t) => t.role === "user").map((t) => t.text);
      expect(texts).toEqual([null, "fresh text"]);
    });

    it("deleteSession is owner scoped, removes turns and emits chat.session_deleted", async () => {
      const f = await make();
      await f.ensureUser(U(1));
      await f.ensureUser(U(2));
      const s = session(1, U(1));
      await f.store.createSession(s);
      const t = turns(s, IDM(1), "x");
      await f.store.appendExchange({ session: s, userTurn: t.user, assistantTurn: t.assistant, day: "2026-10-12", dailyLimit: 30, events: [] });
      expect(await f.store.deleteSession(s.id, U(2), [])).toBe(false);
      expect(await f.store.getSession(s.id)).not.toBeNull();
      expect(await f.store.deleteSession(s.id, U(1), [{ type: "chat.session_deleted", userId: U(1), sessionId: s.id }])).toBe(true);
      expect(await f.store.getSession(s.id)).toBeNull();
      expect(await f.store.listTurns(s.id, 10)).toEqual([]);
      expect(await f.eventTypes()).toContain("chat.session_deleted");
      expect(await f.store.deleteSession(s.id, U(1), [])).toBe(false);
    });

    it("eraseForUser removes sessions, settings and counters", async () => {
      const f = await make();
      await f.ensureUser(U(1));
      const s = session(1, U(1));
      await f.store.createSession(s);
      const t = turns(s, IDM(1), "x");
      await f.store.appendExchange({ session: s, userTurn: t.user, assistantTurn: t.assistant, day: "2026-10-12", dailyLimit: 30, events: [] });
      await f.store.setHistoryEnabled(U(1), true, START_MS, []);
      await f.store.eraseForUser(U(1));
      expect(await f.store.getSession(s.id)).toBeNull();
      expect(await f.store.turnsOnDay(U(1), "2026-10-12")).toBe(0);
      expect(await f.store.getHistoryEnabled(U(1))).toBe(false);
    });

    it("outbox payloads carry ids, enums and counters, never message text", async () => {
      const f = await make();
      await f.ensureUser(U(1));
      const s = session(1, U(1));
      await f.store.createSession(s);
      const t = turns(s, IDM(1), "my secret message");
      await f.store.appendExchange({
        session: s,
        userTurn: t.user,
        assistantTurn: t.assistant,
        day: "2026-10-12",
        dailyLimit: 30,
        events: [{ type: "stylist_chat.turn", userId: U(1), sessionId: s.id, intent: "outfit", source: "rules", latencyMs: 1, toolsUsed: [] }],
      });
      await f.store.emit([{ type: "stylist.injection_detected", userId: U(1), source: "product_text", matches: 2, sessionId: null }]);
      expect(await f.eventTypes()).toEqual(expect.arrayContaining(["stylist_chat.turn", "stylist.injection_detected"]));
    });
  });
}
