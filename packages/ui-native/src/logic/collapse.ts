/** Pure decision logic for the scroll-collapsing header (see components/collapse.tsx). No React, no Reanimated. */

export const COLLAPSE_HIDE_AFTER = 48; // px scrolled before the header may hide
export const COLLAPSE_DIRECTION_SLOP = 6; // px of movement that counts as a direction
export const COLLAPSE_SETTLE_MS = 320; // ignore scroll events caused by the layout shift of our own animation

export interface CollapseState {
  /** Last clamped (>= 0) offset seen. */
  readonly y: number;
  /** Events before this time are layout side effects of our own animation. */
  readonly lockedUntil: number;
  readonly shown: boolean;
}

export const INITIAL_COLLAPSE: CollapseState = { y: 0, lockedUntil: 0, shown: true };

export interface CollapseInput {
  /** Raw contentOffset.y; negative while overscrolling (iOS bounce). */
  readonly rawY: number;
  readonly now: number;
  /** Null until the list reported its size. */
  readonly contentHeight: number | null;
  readonly viewportHeight: number | null;
  /** Natural height of the collapsible header; 0 when unknown. */
  readonly headerHeight: number;
}

export type CollapseAction = "hide" | "show" | "none";
export interface CollapseDecision {
  readonly state: CollapseState;
  readonly action: CollapseAction;
}

/**
 * Hiding the header grows the viewport by the header height, so the list must be able to scroll at least that far
 * without running out of content; otherwise the offset clamps back to 0 and the header would flicker.
 * Unknown sizes allow hiding (nothing to compare).
 */
export function canCollapse(contentHeight: number | null, viewportHeight: number | null, headerHeight: number): boolean {
  if (contentHeight === null || viewportHeight === null) return true;
  return contentHeight - viewportHeight >= headerHeight + COLLAPSE_HIDE_AFTER;
}

function flip(state: CollapseState, y: number, now: number, shown: boolean): CollapseDecision {
  return { state: { y, lockedUntil: now + COLLAPSE_SETTLE_MS, shown }, action: shown ? "show" : "hide" };
}

/** One scroll event in, next state and what the view should do out. */
export function decideCollapse(state: CollapseState, input: CollapseInput): CollapseDecision {
  const y = Math.max(0, input.rawY);
  const delta = y - state.y;
  const next: CollapseState = { ...state, y };
  const locked = input.now < state.lockedUntil;
  if (y <= 0) {
    if (state.shown) return { state: next, action: "none" };
    // Genuine overscroll (rawY < 0) always restores. A plain clamp to 0 right after we hid is the layout shift: wait it out.
    if (input.rawY < 0 || !locked) return flip(state, y, input.now, true);
    return { state: next, action: "none" };
  }
  if (locked) return { state: next, action: "none" };
  if (delta > COLLAPSE_DIRECTION_SLOP && y > COLLAPSE_HIDE_AFTER && state.shown && canCollapse(input.contentHeight, input.viewportHeight, input.headerHeight)) {
    return flip(state, y, input.now, false);
  }
  if (delta < -COLLAPSE_DIRECTION_SLOP && !state.shown) return flip(state, y, input.now, true);
  return { state: next, action: "none" };
}

/** Header content leaves the accessibility tree once it is visually gone. */
export const COLLAPSE_A11Y_HIDE_BELOW = 0.05;
export function headerHiddenFromAssistive(progress: number): boolean {
  return progress < COLLAPSE_A11Y_HIDE_BELOW;
}

/** Collapsing is off for screen reader and Reduce Motion users: layout that moves under them is disorienting. */
export function collapseEnabled(reduceMotion: boolean, screenReaderEnabled: boolean): boolean {
  return !reduceMotion && !screenReaderEnabled;
}
