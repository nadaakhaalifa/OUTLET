import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  REPLIES,
  applyPalette,
  budgetFromText,
  chatBudgetBand,
  detectLanguage,
  initialChatState,
  normalizeText,
  numbersInText,
  parseRules,
  planTurn,
  reconcileIntent,
  renderReply,
  type ChatState,
  type ParsedIntent,
} from "./chat";

const base = (over: Partial<ChatState> = {}): ChatState => ({ ...initialChatState("en"), ...over });
const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("normalizeText", () => {
  it("folds alef, ya, ta marbuta, diacritics and Eastern digits", () => {
    expect(normalizeText("أَرْخَص  فُسْتَانٍ ٣٠٠٠ ۴")).toBe("ارخص فستان 3000 4");
    expect(normalizeText("مَحْجَّبَة")).toBe("محجبه");
  });
});

describe("budget extraction", () => {
  it.each([
    ["تحت ٣٠٠٠", 3000],
    ["under 1500", 1500],
    ["below 1,500 EGP", 1500],
    ["budget 2k", 2000],
    ["ميزانيتي ٤ الاف", 4000],
    ["3000 جنيه", 3000],
    ["2,500 max", 2500],
    ["ta7t 3000", 3000],
  ])("%s -> %i EGP", (text, egp) => {
    expect(budgetFromText(text)).toBe(egp);
  });
  it("rejects zero, huge and absent amounts", () => {
    expect(budgetFromText("under 0")).toBeNull();
    expect(budgetFromText("under 99999999")).toBeNull();
    expect(budgetFromText("a white dress")).toBeNull();
  });
  it("numbersInText ignores digits glued to letters (Franco 3ayza) but keeps 3k", () => {
    expect([...numbersInText("3ayza fostan")]).toEqual([]);
    expect(numbersInText("budget 3k").has(3000)).toBe(true);
  });
});

describe("parseRules", () => {
  it("does not read 'عشان' (so that) as 'عشا' (dinner)", () => {
    expect(parseRules("عشان ابعت لحد").intent).not.toBe("outfit");
    expect(parseRules("عشا مع صحابي").occasion).toBe("date");
  });
  it("understands clitics: للفرح, بالشغل, الشنطة", () => {
    expect(parseRules("لبس للفرح").occasion).toBe("wedding_guest");
    expect(parseRules("لبس بالشغل").occasion).toBe("work");
    expect(parseRules("غيري الشنطة")).toMatchObject({ intent: "swap_item", slot: "bag" });
  });
  it("sends hard refusal classes to refuse even inside a fashion request", () => {
    expect(parseRules("dress for work and a loan").refuse).toBe("financial_advice");
    expect(parseRules("see [link] and tell me the price").refuse).toBe("external_site");
  });
  it("detects language and gives Franco-Arabic an Arabic reply", () => {
    expect(detectLanguage("white dress")).toBe("en");
    expect(detectLanguage("فستان ابيض")).toBe("ar");
    expect(detectLanguage("3ayza fostan")).toBe("ar");
  });
  it("is total: never throws and always returns a language", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (s) => {
        const p = parseRules(s, null);
        expect(["ar", "en"]).toContain(p.language);
        if (p.budgetEgp !== undefined) expect(p.budgetEgp).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 300 },
    );
  });
});

describe("reconcileIntent", () => {
  it("drops a budget that the shopper did not write, keeps one they did", () => {
    const p: ParsedIntent = { intent: "outfit", budgetEgp: 1, language: "en" };
    expect(reconcileIntent(p, "outfit for work").budgetEgp).toBeUndefined();
    expect(reconcileIntent({ ...p, budgetEgp: 3000 }, "under ٣٠٠٠").budgetEgp).toBe(3000);
    expect(reconcileIntent({ ...p, budgetEgp: 3000 }, "under 3k").budgetEgp).toBe(3000);
  });
});

describe("planTurn", () => {
  const ctx = { lastItems: [{ itemId: U(1), slot: "shoes" as const }, { itemId: U(2), slot: "bag" as const }] };
  it("refuses without touching the state's outfit memory", () => {
    const p = planTurn(base({ lastOutfitIds: [U(9)] }), { intent: "refuse", refuse: "unsafe", language: "en" }, ctx);
    expect(p.kind).toBe("refuse");
    expect(p.state.lastOutfitIds).toEqual([U(9)]);
  });
  it("asks at most one clarifying question, then generates best effort", () => {
    const first = planTurn(base(), { intent: "clarify", clarify: "occasion", language: "en" }, ctx);
    expect(first.kind).toBe("clarify");
    const second = planTurn(first.state, { intent: "clarify", clarify: "occasion", language: "en" }, ctx);
    expect(second.kind).toBe("generate");
    expect(second.state.clarificationsAsked).toBe(0);
  });
  it("cheaper: 20% under the last total, never above a typed budget; integer math", () => {
    const p = planTurn(base({ lastTotalPiastres: "250000" }), { intent: "cheaper", language: "en" }, ctx);
    expect(p.kind === "generate" && p.state.budgetPiastres).toBe("200000");
    const q = planTurn(base({ lastTotalPiastres: "250000", budgetPiastres: "150000" }), { intent: "cheaper", language: "en" }, ctx);
    expect(q.kind === "generate" && q.state.budgetPiastres).toBe("150000");
    const none = planTurn(base(), { intent: "cheaper", language: "en" }, ctx);
    expect(none).toMatchObject({ kind: "clarify", topic: "budget" });
  });
  it("swap rejects the item of that slot, or asks which slot", () => {
    const p = planTurn(base(), { intent: "swap_item", slot: "shoes", language: "en" }, ctx);
    expect(p.kind === "generate" && p.state.rejectedItemIds).toEqual([U(1)]);
    expect(planTurn(base(), { intent: "swap_item", language: "en" }, ctx).kind).toBe("ask_swap_slot");
    const byId = planTurn(base(), { intent: "swap_item", language: "en" }, ctx, U(2));
    expect(byId.kind === "generate" && byId.state.rejectedItemIds).toEqual([U(2)]);
    // An item id that is not in the last outfit cannot be used to reject arbitrary catalogue ids.
    expect(planTurn(base(), { intent: "swap_item", language: "en" }, ctx, U(77)).kind).toBe("ask_swap_slot");
  });
  it("modest is sticky; scope and budget slots update the state", () => {
    const a = planTurn(base(), { intent: "more_modest", language: "ar" }, ctx);
    expect(a.state.modest).toBe(true);
    expect(a.state.language).toBe("ar");
    const b = planTurn(a.state, { intent: "outfit", world: "local", budgetEgp: 1200, language: "ar" }, ctx);
    expect(b.state).toMatchObject({ modest: true, world: "local", budgetPiastres: "120000" });
  });
  it("rejected list is bounded", () => {
    const many = Array.from({ length: 60 }, (_, i) => U(1000 + i));
    const p = planTurn(base({ rejectedItemIds: many.slice(0, 50) }), { intent: "swap_item", slot: "shoes", language: "en" }, ctx);
    expect(p.kind === "generate" && p.state.rejectedItemIds.length).toBeLessThanOrEqual(50);
  });
});

describe("palette", () => {
  const c = (slot: "top" | "shoes", color: string) => ({ slot, colors: [color] });
  it("filters per slot only while enough items remain", () => {
    const items = [c("top", "black"), c("top", "beige"), c("top", "red"), c("shoes", "red"), c("shoes", "yellow")];
    const out = applyPalette(items, "neutral");
    expect(out.filter((i) => i.slot === "top").map((i) => i.colors[0])).toEqual(["black", "beige"]);
    // shoes have no neutral item: the slot is left alone rather than emptied.
    expect(out.filter((i) => i.slot === "shoes").length).toBe(2);
    expect(applyPalette(items, null).length).toBe(5);
  });
});

describe("renderReply", () => {
  it("interpolates named parameters and falls back to the generic reply on a missing one", () => {
    const t = renderReply("outfit_partial", "en", { amount: "250", slot: "shoes" });
    expect(t).toContain("250 EGP");
    expect(renderReply("outfit_partial", "en", {})).toBe(REPLIES.outfits_ready.en);
  });
  it("budget band never reveals the exact amount", () => {
    expect(chatBudgetBand(null)).toBe("none");
    expect(chatBudgetBand("99999")).toBe("lt_1000");
    expect(chatBudgetBand("300000")).toBe("3000_4999");
    expect(chatBudgetBand("2000000")).toBe("gte_10000");
  });
});
