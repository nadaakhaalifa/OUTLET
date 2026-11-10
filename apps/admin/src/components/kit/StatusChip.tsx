import type { ReactNode } from "react";

/** A status as words in a tinted pill: the text always carries the meaning, the tint only reinforces it (never colour alone). */
export function StatusChip({ tone, children }: { tone: "ok" | "warn" | "bad" | "info"; children: ReactNode }) {
  return <span className="statusChip" data-tone={tone}>{children}</span>;
}
