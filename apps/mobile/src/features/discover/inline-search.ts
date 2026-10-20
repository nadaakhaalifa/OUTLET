/** Pure rules of the Discover inline search (round-2 item 8). */
import { MAX_QUERY_LENGTH, normalizeQuery, type Suggestion, type SuggestionInput } from "../search/model";

export const MAX_PANEL_RECENTS = 5;
export const SUGGEST_DEBOUNCE_MS = 200;

/** Recents stay on the device; the panel shows the newest five. */
export function panelRecents(recents: readonly string[]): readonly string[] {
  return recents.slice(0, MAX_PANEL_RECENTS);
}

/** Trimmed, at most 100 characters. Returns the query and whether the input had to be cut. */
export function clampQuery(raw: string): { readonly query: string; readonly tooLong: boolean } {
  const q = normalizeQuery(raw);
  return { query: q.slice(0, MAX_QUERY_LENGTH), tooLong: raw.trim().length > MAX_QUERY_LENGTH };
}

export type PanelMode = "recents" | "suggestions" | "results";

export function panelMode(typed: string, submitted: boolean): PanelMode {
  if (submitted) return "results";
  return normalizeQuery(typed).length === 0 ? "recents" : "suggestions";
}

/** Drops answers that are not for the latest request. */
export class LatestOnly {
  private latest = 0;
  begin(): number { return ++this.latest; }
  accepts(id: number): boolean { return id === this.latest; }
}

export const EMPTY_SUGGESTIONS: SuggestionInput = { queries: [], stores: [], categories: [] };

/** Suggestion kind labels use the inlineSearch keys. */
export const KIND_KEY: Readonly<Record<Suggestion["kind"], "inlineSearch.kindQuery" | "inlineSearch.kindStore" | "inlineSearch.kindCategory">> = {
  query: "inlineSearch.kindQuery", store: "inlineSearch.kindStore", category: "inlineSearch.kindCategory",
};

/** Event payload for search_suggestion_tapped: kind and index only, never text. */
export function suggestionTap(s: Suggestion, position: number): { readonly kind: Suggestion["kind"]; readonly position: number } {
  return { kind: s.kind, position: Math.max(0, Math.min(Math.floor(position), 1000)) };
}
