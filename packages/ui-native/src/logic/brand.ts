/** Pure rules for store and brand names (round-2 item 3) and accordion state (item 6). No React. */

/** Lines a store name may take: one on tiles (tail ellipsis), two on rows. */
export type StoreNameLayout = "tile" | "row";
export function storeNameLines(layout: StoreNameLayout): 1 | 2 {
  return layout === "tile" ? 1 : 2;
}

/** The verified glyph appears only for an explicit true (never inferred). */
export function showVerifiedGlyph(verified: boolean | null | undefined): boolean {
  return verified === true;
}

/** One-open-at-a-time accordion: opening a section closes the other; opening the open one closes it. */
export function nextOpenSection(current: string | null, tapped: string): string | null {
  return current === tapped ? null : tapped;
}

/** Header summary such as "Brand, 2 selected": only when something is selected. */
export function sectionSummary(title: string, selectedLabel: string | null): string {
  return selectedLabel === null || selectedLabel.length === 0 ? title : `${title}, ${selectedLabel}`;
}

/** Accessibility state of an accordion header: screen readers announce "expanded" or "collapsed". */
export function headerState(open: boolean): { readonly expanded: boolean } {
  return { expanded: open };
}
