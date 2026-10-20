import { describe, expect, it } from "vitest";
import { breadcrumbFor, isSyntheticEnvironment, navSectionsFor, roleChip } from "./nav";

describe("breadcrumbFor", () => {
  const sections = navSectionsFor(["ops"]);
  it("maps the active item to its group and label", () => {
    expect(breadcrumbFor(sections, "/sellers")).toEqual({ groupKey: "nav.group.queues", itemKey: "nav.sellers" });
    expect(breadcrumbFor(sections, "/sellers/abc")).toEqual({ groupKey: "nav.group.queues", itemKey: "nav.sellers" });
    expect(breadcrumbFor(sections, "/")).toEqual({ groupKey: "nav.group.overview", itemKey: "nav.home" });
  });
  it("is null off-nav and when nothing is visible", () => {
    expect(breadcrumbFor(sections, "/nope")).toBeNull();
    expect(breadcrumbFor(navSectionsFor(null), "/")).toBeNull();
  });
});

describe("roleChip", () => {
  it("shows the first role and the count of the rest", () => {
    expect(roleChip(["Ops", "Finance", "DPO"])).toEqual({ first: "Ops", more: 2, all: ["Ops", "Finance", "DPO"] });
    expect(roleChip(["Ops"])?.more).toBe(0);
  });
  it("is null with no roles", () => expect(roleChip([])).toBeNull());
});

describe("isSyntheticEnvironment", () => {
  it("is true only for a loopback API", () => {
    expect(isSyntheticEnvironment("http://localhost:3917")).toBe(true);
    expect(isSyntheticEnvironment("http://127.0.0.1:3917")).toBe(true);
    expect(isSyntheticEnvironment("https://api.example.com")).toBe(false);
    expect(isSyntheticEnvironment(null)).toBe(false);
    expect(isSyntheticEnvironment("not a url")).toBe(false);
  });
});
