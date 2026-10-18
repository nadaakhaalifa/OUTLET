import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GATEWAY_CONFIG,
  FakeLlmProvider,
  InMemoryAuditStore,
  InMemoryGatewayCache,
  InMemoryTokenUsage,
  LlmGateway,
  STYLIST_CHAT_INTENT,
  StaticFlags,
  defaultRegistry,
  detectInjection,
  scrubPii,
} from "../llm-gateway";
import { GatewayChatIntent } from "./adapters/gateway-chat";
import { REPLIES, initialChatState, parseRules, planTurn, reconcileIntent, type ParsedIntent } from "./domain/chat";
import { GOLDEN, GOLDEN_PROMPT, type GoldenCase } from "./test/chat-golden";
import { U } from "./test/fixtures";

const NOW = 1_800_000_000_000;
const userId = U(1);

function rig(respond: (msg: string) => string, over: Partial<typeof DEFAULT_GATEWAY_CONFIG> = {}) {
  const provider = new FakeLlmProvider();
  provider.respond = (req) => {
    const m = /name="message" trust="untrusted">>\n([\s\S]*?)\n<<END_DATA>>/.exec(req.data);
    return respond(m?.[1] ?? "");
  };
  const audit = new InMemoryAuditStore();
  const gateway = new LlmGateway({
    provider,
    audit,
    usage: new InMemoryTokenUsage(),
    cache: new InMemoryGatewayCache(() => NOW),
    flags: new StaticFlags(new Set(["kill.stylist_llm"])),
    clock: { nowMs: () => NOW },
    ids: { uuidV7: (() => { let n = 0; return () => `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}`; })() },
    config: { ...DEFAULT_GATEWAY_CONFIG, enabled: true, dailyTokensPerUser: 1_000_000, ...over },
    registry: defaultRegistry(),
  });
  return { provider, audit, gateway, port: new GatewayChatIntent(gateway) };
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const subset = (actual: ParsedIntent, want: GoldenCase["expect"]): void => {
  for (const [k, v] of Object.entries(want)) expect((actual as unknown as Record<string, unknown>)[k], k).toEqual(v);
};

// The provider sees the scrubbed text (Eastern digits folded, PII removed): key the recordings the same way.
const recordedByMessage = new Map(GOLDEN.filter((c) => c.recorded !== undefined).map((c) => [scrubPii(c.message).text, c.recorded]));

describe("golden set: recorded model outputs through the real gateway (deterministic fake provider)", () => {
  const cases = GOLDEN.filter((c) => c.neverReachesModel !== true);
  it.each(cases.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    const r = rig((msg) => JSON.stringify(recordedByMessage.get(msg) ?? { intent: "clarify", language: "en" }));
    const scrubbed = scrubPii(c.message).text;
    const out = await r.port.parse({ userId, message: scrubbed, localeHint: null, state: initialChatState("ar"), recentUserTexts: [] });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    subset(reconcileIntent(out.intent, scrubbed), c.expect);
    expect(out.promptHash).toBe(sha(`${STYLIST_CHAT_INTENT.id}@${STYLIST_CHAT_INTENT.version}\n${STYLIST_CHAT_INTENT.system}`));
    expect(out.tokensIn + out.tokensOut).toBeGreaterThan(0);
    // Audit holds hashes and counters only.
    const row = r.audit.rows[0];
    expect(row?.feature).toBe("stylist_chat");
    expect(JSON.stringify(row)).not.toContain(c.message);
  });
});

describe("golden set: rules fallback", () => {
  const cases = GOLDEN.filter((c) => c.rules !== undefined);
  it.each(cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    if (c.rules === undefined) return;
    // The chat scrubs before parsing, so the oracle does too.
    subset(parseRules(scrubPii(c.message).text, null), c.rules);
  });
});

describe("golden set: adversarial and hard-refusal cases never reach the model (100% pass required)", () => {
  const cases = GOLDEN.filter((c) => c.neverReachesModel === true);
  it("the set has adversarial coverage in both scripts", () => {
    expect(cases.filter((c) => c.category === "injection").length).toBeGreaterThanOrEqual(4);
    expect(cases.some((c) => c.script === "ar")).toBe(true);
    expect(cases.some((c) => c.script === "en")).toBe(true);
  });
  it.each(cases.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    // Layer 1: the chat's guard (injection heuristics and deterministic refusal classes).
    const injected = detectInjection(c.message).flagged;
    const rules = parseRules(c.message, null);
    if (c.category === "injection") expect(injected).toBe(true);
    else expect(rules.refuse).toBe(c.expect.refuse);
    // Layer 2: even if it were sent, the gateway refuses an instruction-like required field.
    const r = rig(() => JSON.stringify({ intent: "outfit", language: "en" }));
    const out = await r.port.parse({ userId, message: c.message, localeHint: null, state: initialChatState("ar"), recentUserTexts: [] });
    if (c.category === "injection") {
      expect(out.kind).toBe("unavailable");
      expect(r.provider.calls.length).toBe(0);
    }
    // Planner: whatever arrives, a refusal never plans a generation.
    const plan = planTurn(initialChatState("ar"), c.category === "injection" ? { intent: "refuse", refuse: "injection", language: "en" } : rules, { lastItems: [] });
    expect(plan.kind).toBe("refuse");
  });
});

describe("golden set: data minimisation toward the provider", () => {
  it("no phone number, email, exact budget or id appears in the provider request", async () => {
    const r = rig(() => JSON.stringify({ intent: "outfit", language: "en" }));
    const state = { ...initialChatState("en"), budgetPiastres: "312345", lastOutfitIds: [U(77)], rejectedItemIds: [U(88)] };
    const c = GOLDEN.find((x) => x.id === "en-pii-phone");
    // Raw, unscrubbed input on purpose: the gateway is the second line of defence.
    const out = await r.port.parse({ userId, message: c?.message ?? "", localeHint: "en", state, recentUserTexts: [] });
    expect(out.kind).toBe("ok");
    const sent = r.provider.calls[0]?.data ?? "";
    expect(sent).not.toMatch(/01012345678/);
    expect(sent).not.toMatch(/a@b\.com/);
    expect(sent).not.toContain("312345");
    expect(sent).not.toContain(U(77));
    expect(sent).not.toContain(U(88));
    expect(sent).toContain("3000_4999"); // 3,123.45 EGP is in the 3000 band
    expect(sent).not.toContain(userId);
  });
});

describe("prompt regression", () => {
  it("the registered prompt equals the one the golden set was reviewed against (bump version and review on change)", () => {
    expect(STYLIST_CHAT_INTENT.id).toBe(GOLDEN_PROMPT.id);
    expect(STYLIST_CHAT_INTENT.version).toBe(GOLDEN_PROMPT.version);
    expect(sha(STYLIST_CHAT_INTENT.system)).toBe(GOLDEN_PROMPT.systemSha256);
  });
  it("the output schema is strict: prose, price and id fields are rejected", () => {
    const s = STYLIST_CHAT_INTENT.output;
    expect(s.safeParse({ intent: "outfit", language: "en" }).success).toBe(true);
    for (const extra of [{ reply: "hi" }, { price_piastres: "1" }, { item_ids: ["x"] }, { discount_pct: 100 }]) {
      expect(s.safeParse({ intent: "outfit", language: "en", ...extra }).success).toBe(false);
    }
    expect(s.safeParse({ intent: "outfit", language: "en", budget_egp: 0 }).success).toBe(false);
  });
});

describe("reply catalogue", () => {
  const BANNED = /\b(fat|obese|skinny|thin|ugly|weight|kg|lose|slim(ming)?)\b|سمين|تخين|تخينة|وزن|رفيع|قبيح|تخسيس|دايت/i;
  it("has no body-shaming or weight language in either language", () => {
    for (const [code, t] of Object.entries(REPLIES)) {
      expect(t.ar, code).not.toMatch(BANNED);
      expect(t.en, code).not.toMatch(BANNED);
    }
  });
  it("numbers appear only through named parameters", () => {
    for (const [code, t] of Object.entries(REPLIES)) {
      for (const lang of ["ar", "en"] as const) {
        const withoutParams = t[lang].replace(/\{[a-z_]+\}/g, "");
        expect(withoutParams, `${code}.${lang}`).not.toMatch(/\d/);
      }
    }
  });
});
