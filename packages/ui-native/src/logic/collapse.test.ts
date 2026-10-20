import { describe, expect, it } from "vitest";
import {
  COLLAPSE_HIDE_AFTER, COLLAPSE_SETTLE_MS, INITIAL_COLLAPSE, canCollapse, collapseEnabled, decideCollapse, headerHiddenFromAssistive,
  type CollapseInput, type CollapseState,
} from "./collapse";

const base = { contentHeight: 3000, viewportHeight: 600, headerHeight: 120 };
const ev = (rawY: number, now: number, over: Partial<CollapseInput> = {}): CollapseInput => ({ rawY, now, ...base, ...over });

/** Feeds a sequence of [offset, time] events and returns the actions. */
function run(seq: readonly (readonly [number, number])[], over: Partial<CollapseInput> = {}, from: CollapseState = INITIAL_COLLAPSE) {
  let state = from;
  const actions: string[] = [];
  for (const [y, t] of seq) {
    const d = decideCollapse(state, ev(y, t, over));
    state = d.state;
    actions.push(d.action);
  }
  return { state, actions };
}

describe("decideCollapse", () => {
  it("hides when scrolling down past the threshold, shows when scrolling up", () => {
    const r = run([[10, 0], [30, 16], [60, 32], [90, 48]]);
    expect(r.actions).toEqual(["none", "none", "hide", "none"]);
    expect(r.state.shown).toBe(false);
    const up = run([[200, 1000], [190, 1016]], {}, { y: 210, lockedUntil: 0, shown: false });
    expect(up.actions).toEqual(["show", "none"]);
  });
  it("does not hide before the threshold or on tiny movements", () => {
    expect(run([[COLLAPSE_HIDE_AFTER, 0], [COLLAPSE_HIDE_AFTER + 3, 16]]).actions).toEqual(["none", "none"]);
  });
  it("ignores direction changes inside the settle lock", () => {
    const r = run([[60, 0], [20, 100], [10, 200]]);
    expect(r.actions).toEqual(["hide", "none", "none"]);
    expect(r.state.shown).toBe(false);
  });
  it("short list: the offset clamps back to 0 after hiding and the header does NOT flicker", () => {
    // Content only just taller than the viewport: hiding is refused outright, so nothing happens at all.
    const short = { contentHeight: 640, viewportHeight: 600 };
    const r = run([[40, 0], [60, 16], [20, 400], [60, 800], [0, 1200], [60, 1600]], short);
    expect(r.actions).toEqual(["none", "none", "none", "none", "none", "none"]);
    expect(r.state.shown).toBe(true);
  });
  it("hide, then the layout shift clamps y to 0 inside the lock: stays hidden; after the lock a plain 0 shows once", () => {
    const hide = decideCollapse(INITIAL_COLLAPSE, ev(60, 0));
    expect(hide.action).toBe("hide");
    const clamp = decideCollapse(hide.state, ev(0, 50));
    expect(clamp.action).toBe("none");
    expect(clamp.state.shown).toBe(false);
    const later = decideCollapse(clamp.state, ev(0, COLLAPSE_SETTLE_MS + 60));
    expect(later.action).toBe("show");
    // No loop: the next event at 0 is a no-op.
    expect(decideCollapse(later.state, ev(0, COLLAPSE_SETTLE_MS + 80)).action).toBe("none");
  });
  it("genuine overscroll (negative offset) restores the header even inside the lock", () => {
    const hide = decideCollapse(INITIAL_COLLAPSE, ev(60, 0));
    expect(decideCollapse(hide.state, ev(-20, 40)).action).toBe("show");
  });
  it("reset state is shown with no lock", () => {
    expect(INITIAL_COLLAPSE).toEqual({ y: 0, lockedUntil: 0, shown: true });
    expect(decideCollapse(INITIAL_COLLAPSE, ev(0, 0)).action).toBe("none");
  });
  it("allows hiding when sizes are unknown", () => {
    expect(run([[10, 0], [80, 16]], { contentHeight: null, viewportHeight: null }).actions).toEqual(["none", "hide"]);
  });
});

describe("canCollapse", () => {
  it("needs a scroll range of at least the header height plus the hide threshold", () => {
    expect(canCollapse(1000, 600, 120)).toBe(true);
    expect(canCollapse(700, 600, 120)).toBe(false);
    expect(canCollapse(600 + 120 + COLLAPSE_HIDE_AFTER, 600, 120)).toBe(true);
    expect(canCollapse(null, 600, 120)).toBe(true);
  });
});

describe("assistive tech rules", () => {
  it("hides children from assistive tech below 5% progress", () => {
    expect(headerHiddenFromAssistive(1)).toBe(false);
    expect(headerHiddenFromAssistive(0.06)).toBe(false);
    expect(headerHiddenFromAssistive(0.04)).toBe(true);
    expect(headerHiddenFromAssistive(0)).toBe(true);
  });
  it("never collapses with a screen reader or Reduce Motion", () => {
    expect(collapseEnabled(false, false)).toBe(true);
    expect(collapseEnabled(true, false)).toBe(false);
    expect(collapseEnabled(false, true)).toBe(false);
  });
});
