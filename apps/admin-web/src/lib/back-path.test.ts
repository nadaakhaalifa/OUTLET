import { describe, expect, it } from "vitest";
import { safeBackPath } from "./back-path";
import { parseTheme, themeAttr } from "./theme";

describe("safeBackPath", () => {
  it("keeps same-origin relative paths and queries", () => {
    expect(safeBackPath("/")).toBe("/");
    expect(safeBackPath("/sellers")).toBe("/sellers");
    expect(safeBackPath("/returns?status=open&page=2")).toBe("/returns?status=open&page=2");
  });
  it("drops the one-shot flash param", () => {
    expect(safeBackPath("/plus?r=ok")).toBe("/plus");
    expect(safeBackPath("/plus?r=ok&tab=a")).toBe("/plus?tab=a");
  });
  it.each(["//evil.test", "//evil.test/x", "/\\evil.test", "\\\\evil.test", "https://evil.test", "javascript:alert(1)", "evil", "", "/a\nb", "/a\\b", "/\t/evil.test", `/${"a".repeat(600)}`])(
    "rejects %j",
    (v) => expect(safeBackPath(v)).toBe("/"),
  );
  it("rejects non-strings", () => {
    expect(safeBackPath(null)).toBe("/");
    expect(safeBackPath(undefined)).toBe("/");
  });
});

describe("theme cookie", () => {
  it("falls back to system", () => {
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("x")).toBe("system");
    expect(parseTheme(undefined)).toBe("system");
    expect(themeAttr("system")).toBeUndefined();
    expect(themeAttr("dark")).toBe("dark");
  });
});
