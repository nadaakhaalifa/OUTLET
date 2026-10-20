import { afterEach, describe, expect, it, vi } from "vitest";
import { clearDevHints, getDevHints, isDevBadgeVisible, registerDevHint, subscribeDevHints } from "./dev-hints";

afterEach(() => clearDevHints());

describe("dev hints", () => {
  it("registers and replaces by id", () => {
    registerDevHint("a", "one");
    registerDevHint("a", "two");
    registerDevHint("b", "three");
    expect(getDevHints()).toEqual([{ id: "a", text: "two" }, { id: "b", text: "three" }]);
  });
  it("never notifies subscribers synchronously and batches into one call", async () => {
    const fn = vi.fn();
    const off = subscribeDevHints(fn);
    registerDevHint("x", "one");
    registerDevHint("y", "two");
    expect(fn).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(1);
    off();
  });
  it("is idempotent by id and keeps a stable snapshot", async () => {
    const fn = vi.fn();
    registerDevHint("a", "one");
    await Promise.resolve();
    const off = subscribeDevHints(fn);
    const snap = getDevHints();
    registerDevHint("a", "one");
    await Promise.resolve();
    expect(fn).not.toHaveBeenCalled();
    expect(getDevHints()).toBe(snap);
    off();
  });
  it("shows the badge only in dev, on fixtures, and not when hidden", () => {
    const fx = { kind: "fixture" } as const;
    expect(isDevBadgeVisible(fx, true, undefined)).toBe(true);
    expect(isDevBadgeVisible(fx, true, "1")).toBe(false);
    expect(isDevBadgeVisible(fx, false, undefined)).toBe(false);
    expect(isDevBadgeVisible({ kind: "api", baseUrl: "https://x.example" }, true, undefined)).toBe(false);
  });
});
