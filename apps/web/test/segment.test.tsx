import { describe, expect, it, vi } from "vitest";

const { notFound } = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/navigation", () => ({ notFound }));

import { requireLocale } from "../src/lib/segment-page";
import { alternateLinks, parseSegment } from "../src/lib/segment";
import { pageMetadata } from "../src/lib/metadata";

describe("segment validation", () => {
  it("resolves eg-ar and eg-en with direction", () => {
    expect(parseSegment("eg-ar")).toMatchObject({ marketId: "eg", locale: "ar-EG", dir: "rtl" });
    expect(parseSegment("eg-en")).toMatchObject({ locale: "en-EG", dir: "ltr" });
  });
  it("404s on an invalid segment", async () => {
    for (const bad of ["xx-ar", "eg-fr", "EG-AR", "deals", "eg"]) {
      await expect(requireLocale(Promise.resolve({ segment: bad }))).rejects.toThrow("NEXT_NOT_FOUND");
    }
    expect(notFound).toHaveBeenCalled();
  });
  it("returns the resolved locale for a valid segment", async () => {
    await expect(requireLocale(Promise.resolve({ segment: "eg-en" }))).resolves.toMatchObject({ locale: "en-EG" });
  });
});

describe("metadata alternates", () => {
  const ar = parseSegment("eg-ar");
  it("lists hreflang alternates for both locales plus x-default, and a self canonical", () => {
    expect(ar).not.toBeNull();
    if (ar === null) return;
    const links = alternateLinks(ar, "/deals");
    expect(links.canonical).toBe("/eg-ar/deals");
    expect(links.languages).toEqual({ "ar-EG": "/eg-ar/deals", "en-EG": "/eg-en/deals", "x-default": "/eg-ar/deals" });
  });
  it("puts alternates on page metadata, canonical per locale", () => {
    const en = parseSegment("eg-en");
    if (en === null) throw new Error("eg-en must resolve");
    const md = pageMetadata(en, "/p/abc", "nav.explore");
    expect(md.alternates?.canonical).toBe("/eg-en/p/abc");
    expect(md.alternates?.languages).toMatchObject({ "ar-EG": "/eg-ar/p/abc", "en-EG": "/eg-en/p/abc" });
  });
});

describe("alternateLinks x-default for a market without an Arabic locale", () => {
  it("falls back to the market's own language segment and lists no hreflang it cannot resolve", () => {
    const links = alternateLinks({ marketId: "zz", locale: "en-EG", dir: "ltr" }, "/deals");
    expect(links.languages).toEqual({ "x-default": "/zz-en/deals" });
    expect(links.canonical).toBe("/zz-en/deals");
  });
});
