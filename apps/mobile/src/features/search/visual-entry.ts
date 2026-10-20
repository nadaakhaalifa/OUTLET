/**
 * The camera icon in the search field exists only while kill.visual_search is open. The state is tri-valued: `null`
 * (unknown, not loaded or no flag source) hides it, so the entry fails closed. InlineSearch shows the icon exactly when
 * it receives a handler, so callers must obtain it here.
 */
export function visualSearchEntry(killOpen: boolean | null, open: () => void): (() => void) | undefined {
  return killOpen === true ? open : undefined;
}
