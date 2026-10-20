import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "ok" | "warn" | "bad" | "info";

/** Shape cue per tone, so meaning never rests on colour alone (WCAG 1.4.1): glyph + border style + the text itself. */
const GLYPH: Readonly<Record<BadgeTone, string>> = { neutral: "○", ok: "✓", warn: "▲", bad: "✕", info: "◆" };

/** Status pill: glyph (decorative), then the required text label. */
export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span className={tone === "neutral" ? "uw-badge" : `uw-badge uw-badge-${tone}`} data-tone={tone}>
      <span className="uw-badge-glyph" aria-hidden="true">{GLYPH[tone]}</span>
      <span>{children}</span>
    </span>
  );
}
export { Badge as StatusPill };
