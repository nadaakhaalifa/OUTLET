import { describe, expect, it } from "vitest";
import { createClient, type FetchLike } from "../../services/api-client";
import type { AdapterContext } from "../../services/wire";
import { AiFailure, failureOf } from "../ai-failure";
import { ApiStylistChatPort, parseBlocks } from "./api";
import {
  InMemoryChatPort, QUOTA_HINT_AT, actionForOption, checkInput, chatOutfitView, eraseAll, failureView, historyStep, isRefusalCode, quotaHint, sortSessions,
  type ChatOutfit, type ChatSession,
} from "./model";
import { FIXTURE_OUTFITS } from "../stylist/model";

const SID = "0192f3a4-5b6c-7d8e-9f01-23456789abc1";
const OID = "0192f3a4-5b6c-7d8e-9f01-23456789abc2";
const IID = "0192f3a4-5b6c-7d8e-9f01-23456789abc3";
const TS = "2026-10-11T10:00:00Z";

interface Req { method: string; path: string; body: unknown }
type Handler = (r: Req) => { status?: number; body?: unknown; code?: string };

function harness(routes: Record<string, Handler>) {
  const calls: Req[] = [];
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const req: Req = { method: init?.method ?? "GET", path: u.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(req);
    const h = routes[`${req.method} ${req.path}`];
    if (h === undefined) return new Response(JSON.stringify({ type: "/p/nf", title: "nf", status: 404 }), { status: 404, headers: { "Content-Type": "application/problem+json" } });
    const r = h(req);
    const status = r.status ?? 200;
    if (status >= 400) return new Response(JSON.stringify({ type: "/p/x", title: "x", status, code: r.code }), { status, headers: { "Content-Type": "application/problem+json" } });
    return new Response(status === 204 ? null : JSON.stringify(r.body ?? {}), { status, headers: { "Content-Type": "application/json" } });
  };
  const client = createClient({ baseUrl: "https://api.test", fetch, getToken: () => "tok", sleep: async () => undefined, randomBytes: (n) => new Uint8Array(n).fill(3), maxRetries: 0 });
  const ctx: AdapterContext = { client, locale: () => "ar", nowMs: () => Date.parse(TS), deviceId: () => "install-device-1" };
  return { ctx, calls };
}

const session = { id: SID, ai_notice: "AI suggestions", language: "ar", scope: {}, history_enabled: false, created_at: TS, updated_at: TS };

describe("chat input", () => {
  it("never sends empty text and caps long text", () => {
    expect(checkInput("   ")).toEqual({ ok: false });
    expect(checkInput(" hi ")).toEqual({ ok: true, text: "hi", truncated: false });
    const long = checkInput("x".repeat(2500));
    expect(long.ok && long.truncated && long.text.length).toBe(2000);
  });
  it("shows the quota only when few turns remain", () => {
    expect(quotaHint(null)).toBeNull();
    expect(quotaHint(QUOTA_HINT_AT + 1)).toBeNull();
    expect(quotaHint(QUOTA_HINT_AT)).toBe(QUOTA_HINT_AT);
    expect(quotaHint(0)).toBe(0);
  });
});

describe("chips and quick actions", () => {
  it("maps known ids to wire actions and refuses unknown ones", () => {
    expect(actionForOption("quick", "cheaper")).toEqual({ type: "cheaper" });
    expect(actionForOption("quick", "scope_everything")).toEqual({ type: "scope", world: "everything" });
    expect(actionForOption("quick", "delete_everything")).toBeNull();
    expect(actionForOption("chip", "wedding_guest", "occasion")).toEqual({ type: "chip", topic: "occasion", value: "wedding_guest" });
    expect(actionForOption("chip", "Bad Id!", "occasion")).toBeNull();
    expect(actionForOption("chip", "neutral")).toBeNull();
  });
  it("recognises refusal codes", () => {
    expect(isRefusalCode("refuse_financial")).toBe(true);
    expect(isRefusalCode("outfits_ready")).toBe(false);
  });
});

describe("outfit block view", () => {
  const outfit = FIXTURE_OUTFITS[0]!;
  const base: ChatOutfit = { outfit, complete: true, live: {} };
  it("uses catalogue prices and flags unavailable and changed items", () => {
    expect(chatOutfitView(base).total).toBe(210_000n);
    const v = chatOutfitView({ ...base, live: { a1: { available: true, currentPrice: 130_000n, priceChanged: true }, a2: { available: false, currentPrice: null, priceChanged: false } } });
    expect(v.total).toBe(130_000n + 30_000n);
    expect(v.unavailable).toEqual(["a2"]);
    expect(v.changed).toEqual(["a1"]);
    expect(v.addable).toBe(true);
  });
  it("cannot be added when every item is gone", () => {
    const live = Object.fromEntries(outfit.items.map((i) => [i.skuId, { available: false, currentPrice: null, priceChanged: false }]));
    expect(chatOutfitView({ ...base, live }).addable).toBe(false);
  });
});

describe("failures", () => {
  it("quota and kill switch offer the structured stylist; rate limit offers retry", () => {
    expect(failureView("quota")).toMatchObject({ offerStructured: true, retry: false });
    expect(failureView("disabled")).toMatchObject({ offerStructured: true, retry: false });
    expect(failureView("rateLimited")).toMatchObject({ retry: true });
  });
  it("turning history off with saved chats asks first", () => {
    expect(historyStep(true, false, 2)).toBe("confirmErase");
    expect(historyStep(true, false, 0)).toBe("apply");
    expect(historyStep(false, true, 5)).toBe("apply");
  });
});

describe("erase all", () => {
  it("deletes every session and counts failures", async () => {
    const port = new InMemoryChatPort();
    const a = await port.createSession("en");
    const b = await port.createSession("en");
    const r = await eraseAll(port, [a, b, { ...b, id: "ghost" }]);
    expect(r).toEqual({ deleted: 2, failed: 1 });
    expect(await port.listSessions()).toEqual([]);
  });
  it("sorts newest first", () => {
    const s = (id: string, t: number): ChatSession => ({ id, language: "ar", historyEnabled: false, updatedAtMs: t });
    expect(sortSessions([s("a", 1), s("b", 3), s("c", 2)]).map((x) => x.id)).toEqual(["b", "c", "a"]);
  });
});

describe("in-memory chat port", () => {
  it("answers, refuses credit advice, enforces the daily quota and honours history off", async () => {
    const port = new InMemoryChatPort(2);
    const s = await port.createSession("en");
    const t1 = await port.send(s.id, { text: "a dress for a wedding under 3000" }, "en");
    expect(t1.blocks.some((b) => b.kind === "outfits")).toBe(true);
    expect(t1.remainingToday).toBe(1);
    const t2 = await port.send(s.id, { text: "can I get a loan for this" }, "en");
    expect(t2.blocks[0]).toMatchObject({ kind: "text", refusal: true });
    await expect(port.send(s.id, { text: "another outfit please" }, "en")).rejects.toMatchObject({ reason: "quota" });
    const loaded = await port.loadSession(s.id);
    expect(loaded.messages.filter((m) => m.role === "user").every((m) => m.text === null)).toBe(true);
  });
  it("keeps user text only when history is on", async () => {
    const port = new InMemoryChatPort();
    await port.setHistoryEnabled(true);
    const s = await port.createSession("ar");
    await port.send(s.id, { text: "فستان للعمل" }, "ar");
    expect((await port.loadSession(s.id)).messages[0]?.text).toBe("فستان للعمل");
  });
  it("surfaces configured failures", async () => {
    const port = new InMemoryChatPort(30, "llm", "disabled");
    await expect(port.listSessions()).rejects.toBeInstanceOf(AiFailure);
  });
});

describe("parseBlocks", () => {
  it("validates each block and drops malformed or unknown ones", () => {
    const blocks = parseBlocks([
      { type: "text", code: "refuse_unsafe", text: "no" },
      { type: "chips", topic: "occasion", options: [{ id: "work", label_ar: "شغل", label_en: "Work" }] },
      { type: "quick_actions", options: [{ id: "cheaper", label_ar: "أرخص", label_en: "Cheaper" }] },
      { type: "outfits", outfits: [{ id: OID, complete: false, items: [{ item_id: IID, store_id: SID, slot: "dress", price_piastres: "120000" }], per_store: [{ store_id: SID }], missing: [{ slot: "shoes", add_piastres: "25000" }], live: [{ item_id: IID, available: true, current_price_piastres: "125000", price_changed: true }] }] },
      { type: "html", html: "<script>" },
      { type: "chips", topic: "nonsense", options: [] },
      { type: "text" },
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["text", "chips", "quick", "outfits"]);
    expect(blocks[0]).toMatchObject({ refusal: true });
    const o = blocks[3];
    if (o?.kind !== "outfits") throw new Error("expected outfits");
    expect(o.outfits[0]?.live[IID]).toEqual({ available: true, currentPrice: 125_000n, priceChanged: true });
    expect(o.outfits[0]?.outfit.missing).toEqual([{ slot: "shoes", shortfall: 25_000n }]);
    expect(o.outfits[0]?.outfit.items[0]?.unitPrice).toBe(120_000n);
  });
});

describe("ApiStylistChatPort", () => {
  it("creates a session, sends a text turn and parses the reply", async () => {
    const { ctx, calls } = harness({
      "POST /v1/stylist/chat/sessions": () => ({ status: 201, body: session }),
      [`POST /v1/stylist/chat/sessions/${SID}/messages`]: () => ({
        body: {
          ai_notice: "AI suggestions", session_id: SID, turn_id: OID, seq: 2, source: "rules", intent: "outfit", language: "en", truncated: false, replay: false,
          blocks: [{ type: "text", code: "outfits_ready", text: "Here you go" }], quota: { remaining_today: 4 },
        },
      }),
    });
    const port = new ApiStylistChatPort(ctx);
    const s = await port.createSession("en");
    expect(s).toMatchObject({ id: SID, language: "ar", historyEnabled: false });
    const t = await port.send(s.id, { text: "hello" }, "en");
    expect(t).toMatchObject({ source: "rules", remainingToday: 4, seq: 2 });
    expect(calls[1]?.body).toEqual({ text: "hello", locale: "en" });
  });
  it("sends chip actions with their topic and value", async () => {
    const { ctx, calls } = harness({
      [`POST /v1/stylist/chat/sessions/${SID}/messages`]: () => ({
        body: { ai_notice: "AI suggestions", session_id: SID, turn_id: OID, seq: 1, source: "llm", intent: "outfit", language: "ar", truncated: false, replay: false, blocks: [], quota: {} },
      }),
    });
    const t = await new ApiStylistChatPort(ctx).send(SID, { action: { type: "chip", topic: "budget", value: "3000" } }, "ar");
    expect(t.remainingToday).toBeNull();
    expect(calls[0]?.body).toEqual({ action: { type: "chip", topic: "budget", value: "3000" }, locale: "ar" });
  });
  it("maps the daily quota (429) and the kill switch (503) to explicit reasons", async () => {
    const { ctx } = harness({
      [`POST /v1/stylist/chat/sessions/${SID}/messages`]: () => ({ status: 429, code: "chat_quota_exceeded" }),
      "GET /v1/stylist/chat/sessions": () => ({ status: 503, code: "stylist_chat_disabled" }),
    });
    const port = new ApiStylistChatPort(ctx);
    await expect(port.send(SID, { text: "hi" }, "en")).rejects.toMatchObject({ reason: "quota" });
    await expect(port.listSessions()).rejects.toMatchObject({ reason: "disabled" });
  });
  it("reads and writes the history setting and deletes sessions", async () => {
    const { ctx, calls } = harness({
      "GET /v1/me/stylist-chat/settings": () => ({ body: { history_enabled: true } }),
      "PATCH /v1/me/stylist-chat/settings": (r) => ({ body: r.body }),
      [`DELETE /v1/stylist/chat/sessions/${SID}`]: () => ({ status: 204 }),
    });
    const port = new ApiStylistChatPort(ctx);
    expect(await port.getSettings()).toEqual({ historyEnabled: true });
    expect(await port.setHistoryEnabled(false)).toEqual({ historyEnabled: false });
    await port.deleteSession(SID);
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH", "DELETE"]);
  });
  it("loads a session transcript with null text when history is off", async () => {
    const { ctx } = harness({
      [`GET /v1/stylist/chat/sessions/${SID}`]: () => ({
        body: { ...session, turns: [{ seq: 1, role: "assistant", text: null, source: "llm", blocks: [{ type: "text", code: "x", text: "hi" }], created_at: TS }] },
      }),
    });
    const r = await new ApiStylistChatPort(ctx).loadSession(SID);
    expect(r.messages[0]).toMatchObject({ role: "assistant", text: null, source: "llm" });
    expect(failureOf(new Error("x")).reason).toBe("failed");
  });
});
