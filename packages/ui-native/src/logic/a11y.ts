export type A11yRole = "button" | "header" | "text" | "checkbox" | "switch" | "alert" | "none" | "progressbar" | "summary";

export interface A11yIssue { readonly rule: string; readonly detail: string }

/** Interactive elements need a non-empty accessible name. */
export function accessibleName(label: string | undefined, fallbackText: string | undefined): string | null {
  const l = label?.trim();
  if (l) return l;
  const f = fallbackText?.trim();
  return f ? f : null;
}

export function validateInteractive(input: { role: A11yRole; name: string | null; width: number; height: number; minTarget: number }): A11yIssue[] {
  const out: A11yIssue[] = [];
  if (input.name === null) out.push({ rule: "name", detail: "interactive element has no accessible name" });
  if (input.width < input.minTarget || input.height < input.minTarget)
    out.push({ rule: "target-size", detail: `${input.width}x${input.height} is below ${input.minTarget}pt` });
  return out;
}

/** Composes label + state hint, e.g. for ListRow: "Title, subtitle". */
export function joinLabel(...parts: ReadonlyArray<string | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === "string" && p.trim().length > 0).join(", ");
}
