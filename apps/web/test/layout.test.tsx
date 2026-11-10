import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  usePathname: () => "/eg-ar",
}));
vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers({ "x-nonce": "n0nce" })),
  cookies: () => Promise.resolve({ get: () => undefined }),
}));
vi.mock("next/font/local", () => ({ default: () => ({ variable: "fontvar", className: "fontcls" }) }));
vi.mock("../src/components/ui", async () => await import("@outlet/ui-web"));

const { default: SegmentLayout } = await import("../src/app/[segment]/layout");

async function render(segment: string): Promise<string> {
  const tree = await SegmentLayout({ children: null, params: Promise.resolve({ segment }) });
  return renderToStaticMarkup(tree);
}

describe("[segment] layout", () => {
  it("sets lang and dir=rtl for eg-ar and renders the header", async () => {
    const html = await render("eg-ar");
    expect(html).toMatch(/<html[^>]*lang="ar"/);
    expect(html).toMatch(/<html[^>]*dir="rtl"/);
    expect(html).toContain('role="search"');
    expect(html).toContain('href="/eg-ar/bag"');
  });
  it("sets dir=ltr for eg-en and emits nonced JSON-LD", async () => {
    const html = await render("eg-en");
    expect(html).toMatch(/<html[^>]*dir="ltr"/);
    expect(html).toMatch(/<script type="application\/ld\+json" nonce="n0nce">/);
    expect(html).toContain('"@type":"WebSite"');
    expect(html).toContain("SearchAction");
  });
  it("404s for an invalid segment", async () => {
    await expect(render("zz-ar")).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
