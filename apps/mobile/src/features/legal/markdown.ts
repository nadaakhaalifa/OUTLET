/** Tiny markdown reader for the bundled legal drafts: headings, quotes, paragraphs, lists, table rows, bold. Pure. */
export interface Span {
  readonly text: string;
  readonly bold: boolean;
}

export type Block =
  | { readonly kind: "h1" | "h2" | "h3" | "quote" | "p" | "li" | "row"; readonly spans: readonly Span[] };

/** Splits `**bold**` and strips inline code ticks. Unbalanced markers stay literal. */
export function inline(raw: string): readonly Span[] {
  const clean = raw.replace(/`([^`]*)`/g, "$1");
  const parts = clean.split("**");
  if (parts.length % 2 === 0) return [{ text: clean, bold: false }];
  const spans: Span[] = [];
  parts.forEach((p, i) => {
    if (p !== "") spans.push({ text: p, bold: i % 2 === 1 });
  });
  return spans;
}

const isRule = (line: string): boolean => /^\|?[\s:|-]+\|?$/.test(line) && line.includes("-");

export function parseMarkdown(source: string): readonly Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length > 0) out.push({ kind: "p", spans: inline(para.join(" ")) });
    para = [];
  };
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (trimmed === "") { flush(); continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (h !== null) {
      flush();
      const level = (h[1] ?? "#").length;
      out.push({ kind: level === 1 ? "h1" : level === 2 ? "h2" : "h3", spans: inline(h[2] ?? "") });
      continue;
    }
    if (trimmed.startsWith(">")) { flush(); out.push({ kind: "quote", spans: inline(trimmed.replace(/^>\s?/, "")) }); continue; }
    if (trimmed.startsWith("|")) {
      flush();
      if (isRule(trimmed)) continue;
      const cells = trimmed.split("|").map((c) => c.trim()).filter((c) => c !== "");
      out.push({ kind: "row", spans: inline(cells.join("  ·  ")) });
      continue;
    }
    const li = /^[-*]\s+(.*)$/.exec(trimmed);
    if (li !== null) { flush(); out.push({ kind: "li", spans: inline(li[1] ?? "") }); continue; }
    para.push(trimmed);
  }
  flush();
  return out;
}

/** Plain text of a block (for accessibility labels and tests). */
export const blockText = (b: Block): string => b.spans.map((s) => s.text).join("");
