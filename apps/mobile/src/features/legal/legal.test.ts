import { describe, expect, it } from "vitest";
import { LEGAL_DOCS } from "./generated/legal-docs";
import { blockText, inline, parseMarkdown } from "./markdown";
import { LEGAL_DOC_IDS, SETTINGS_LEGAL_LINKS, isLegalDocId, legalDocView } from "./model";

describe("markdown", () => {
  it("parses headings, quotes, lists, tables and bold", () => {
    const b = parseMarkdown("# T\n\n> **x** y\n\n## 1. A\npara one\ncontinued\n\n- item\n| a | b |\n|---|---|\n| c | d |");
    expect(b.map((x) => x.kind)).toEqual(["h1", "quote", "h2", "p", "li", "row", "row"]);
    expect(blockText(b[3]!)).toBe("para one continued");
    expect(blockText(b[6]!)).toBe("c  ·  d");
    expect(inline("a **b** c").map((s) => s.bold)).toEqual([false, true, false]);
  });
  it("keeps unbalanced bold literal and strips code ticks", () => {
    expect(inline("a ** b")[0]?.text).toBe("a ** b");
    expect(inline("`VR-08`")[0]?.text).toBe("VR-08");
  });
});

describe("bundled legal drafts", () => {
  it("has AR and EN text for every id, and every Settings link exists", () => {
    for (const id of LEGAL_DOC_IDS) {
      expect(LEGAL_DOCS[id].en.length).toBeGreaterThan(100);
      expect(LEGAL_DOCS[id].ar.length).toBeGreaterThan(100);
    }
    expect(SETTINGS_LEGAL_LINKS.every((i) => isLegalDocId(i))).toBe(true);
  });
  it("marks every document as a draft and starts with a title", () => {
    const v = legalDocView("terms-of-service", "ar");
    expect(v.draft).toBe(true);
    expect(v.blocks[0]?.kind).toBe("h1");
    expect(isLegalDocId("nope")).toBe(false);
  });
});
