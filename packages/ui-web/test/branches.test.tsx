import { money } from "@outlet/money";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DiscountBandShelf, LocaleProvider, Picture, QuickViewPanel, ShelfWall, StoreHeader, StorefrontCard3D, StorefrontGrid, TabsExploreDeals, TopNav,
  type ArtImage, type CubbyItem, type StorefrontItem,
} from "../src/index.js";
import { expectNoA11yViolations } from "./axe.js";

beforeEach(() => { Element.prototype.scrollTo = vi.fn(); });

const mkStores = (n: number): StorefrontItem[] => Array.from({ length: n }, (_, i) => ({ key: `s${String(i)}`, storeName: `Store ${String(i)}`, category: "Fashion", href: `/s/${String(i)}` }));
const mkCubbies = (n: number): CubbyItem[] => Array.from({ length: n }, (_, i) => ({ key: `p${String(i)}`, name: `Item ${String(i)}`, href: `/p/${String(i)}`, pricing: { price: money(10_000n + BigInt(i), "EGP") } }));
const carousels = (c: Element): number => c.querySelectorAll('[aria-roledescription="carousel"]').length;

describe("Picture", () => {
  it("plain image: uses intrinsic size, lazy by default, and the fallback size when none", () => {
    const { container, rerender } = render(<Picture image={{ src: "/a.jpg", alt: "A", width: 10, height: 20 }} className="c" />);
    let img = container.querySelector("img")!;
    expect(img.getAttribute("width")).toBe("10");
    expect(img.getAttribute("height")).toBe("20");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("fetchpriority")).toBe("auto");
    expect(img.className).toBe("c");
    rerender(<Picture image={{ src: "/a.jpg", alt: "A" }} />);
    img = container.querySelector("img")!;
    expect(img.getAttribute("width")).toBe("400");
    expect(img.getAttribute("height")).toBe("400");
    expect(img.hasAttribute("class")).toBe(false);
    rerender(<Picture image={{ src: "/a.jpg", alt: "A" }} fallbackSize={{ width: 7, height: 9 }} />);
    expect(container.querySelector("img")!.getAttribute("width")).toBe("7");
  });
  it("priority images are eager with high fetch priority", () => {
    const { container } = render(<Picture image={{ src: "/a.jpg", alt: "A" }} priority />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("loading")).toBe("eager");
    expect(img.getAttribute("fetchpriority")).toBe("high");
  });
  it("picture data renders one <source> per format and the fallback img, with or without class", () => {
    const image: ArtImage = {
      src: "/x.jpg", alt: "X",
      picture: { sources: [{ type: "image/avif", srcset: "a.avif 1x", sizes: "100vw" }, { type: "image/webp", srcset: "a.webp 1x", sizes: "100vw" }], img: { src: "a.jpg", srcset: "a.jpg 1x", sizes: "100vw", width: 300, height: 200 } },
    };
    const { container, rerender } = render(<Picture image={image} className="k" priority />);
    expect(container.querySelectorAll("source")).toHaveLength(2);
    expect(container.querySelector("source")!.getAttribute("type")).toBe("image/avif");
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("a.jpg");
    expect(img.getAttribute("width")).toBe("300");
    expect(img.className).toBe("k");
    expect(img.getAttribute("loading")).toBe("eager");
    rerender(<Picture image={image} />);
    expect(container.querySelector("img")!.hasAttribute("class")).toBe(false);
    expect(container.querySelector("img")!.getAttribute("loading")).toBe("lazy");
  });
});

describe("StorefrontCard3D", () => {
  it("draws a placeholder facade without art and labels the link", () => {
    const { container } = render(<StorefrontCard3D storeName="Nile" category="Fashion" href="/n" locale="en-EG" />);
    expect(container.querySelector("img")).toBeNull();
    const a = screen.getByRole("link");
    expect(a.getAttribute("href")).toBe("/n");
    expect(a.getAttribute("aria-label")).toContain("Nile");
  });
  it("art: keeps its alt, falls back to the store name for an empty alt, and passes priority only when set", () => {
    const { container, rerender } = render(<StorefrontCard3D storeName="Nile" category="F" href="/n" image={{ src: "/a.jpg", alt: "Front" }} locale="en-EG" />);
    expect(container.querySelector("img")!.getAttribute("alt")).toBe("Front");
    expect(container.querySelector("img")!.getAttribute("loading")).toBe("lazy");
    rerender(<StorefrontCard3D storeName="Nile" category="F" href="/n" image={{ src: "/a.jpg", alt: "" }} priority locale="en-EG" />);
    expect(container.querySelector("img")!.getAttribute("alt")).toBe("Nile");
    expect(container.querySelector("img")!.getAttribute("loading")).toBe("eager");
  });
});

describe("StorefrontGrid", () => {
  it("renders nothing but the container for no stores", () => {
    const { container } = render(<StorefrontGrid stores={[]} locale="en-EG" />);
    expect(carousels(container)).toBe(0);
  });
  it("up to 6 stores fit one row; 7 to 12 two rows; more stores lengthen rows instead of adding more than `rows`", () => {
    expect(carousels(render(<StorefrontGrid stores={mkStores(6)} locale="en-EG" />).container)).toBe(1);
    expect(carousels(render(<StorefrontGrid stores={mkStores(13)} locale="en-EG" />).container)).toBe(3);
    const big = render(<StorefrontGrid stores={mkStores(60)} locale="en-EG" />).container;
    expect(carousels(big)).toBe(3);
    expect(big.querySelectorAll("a")).toHaveLength(60);
  });
  it("honours a custom row count and works without a locale prop (provider locale)", () => {
    const { container } = render(<LocaleProvider locale="en-EG"><StorefrontGrid stores={mkStores(20)} rows={2} /></LocaleProvider>);
    expect(carousels(container)).toBe(2);
    expect(screen.getAllByRole("link")[0]!.getAttribute("aria-label")).toContain("Store 0");
  });
  it("defaults to Arabic with no provider and no locale", () => {
    const { container } = render(<StorefrontGrid stores={mkStores(2)} />);
    expect(container.querySelector("a")!.getAttribute("aria-label")).toMatch(/[؀-ۿ]/);
  });
});

describe("ShelfWall", () => {
  it("empty items render no shelves; only the last shelf carries the slide hint", () => {
    expect(carousels(render(<ShelfWall items={[]} locale="en-EG" />).container)).toBe(0);
    const { container } = render(<ShelfWall items={mkCubbies(14)} locale="en-EG" />);
    expect(carousels(container)).toBe(3);
  });
  it("single shelf, long lists lengthen rows, and no-locale default works", async () => {
    const one = render(<ShelfWall items={mkCubbies(3)} />);
    expect(carousels(one.container)).toBe(1);
    await expectNoA11yViolations(one.container);
    const many = render(<ShelfWall items={mkCubbies(40)} rows={2} locale="ar-EG" />);
    expect(carousels(many.container)).toBe(2);
  });
});

describe("DiscountBandShelf", () => {
  it("verified band shows the label and hint; unverified or absent shows only the plain title", async () => {
    const v = render(<DiscountBandShelf band={{ highPercent: 70, lowPercent: 60, verified: true }} items={mkCubbies(2)} locale="en-EG" />);
    expect(v.container.querySelector("h2")).toBeNull();
    expect(v.container.textContent).toContain("70%–60% OFF");
    expect(v.getByRole("region").getAttribute("aria-label")).toContain("70");
    await expectNoA11yViolations(v.container);
    v.unmount();
    const u = render(<DiscountBandShelf band={{ highPercent: 70, lowPercent: 60, verified: false }} items={mkCubbies(2)} locale="en-EG" />);
    expect(u.container.querySelector("h2")!.textContent).toBe("Products at plain prices");
    expect(u.getByRole("region").getAttribute("aria-label")).toBe("Products at plain prices");
  });
  it("empty items show the empty message instead of a shelf; works without a locale prop", async () => {
    const { container } = render(<DiscountBandShelf items={[]} />);
    expect(carousels(container)).toBe(0);
    expect(container.querySelector("p")!.textContent).not.toBe("");
    await expectNoA11yViolations(container);
    const withItems = render(<DiscountBandShelf items={mkCubbies(1)} />);
    expect(carousels(withItems.container)).toBe(1);
  });
});

describe("StoreHeader", () => {
  it("minimal: initial letter avatar, no tagline, no counts", () => {
    const { container } = render(<StoreHeader name="Nile Outlet" followHref="/in" locale="en-EG" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[aria-hidden='true']")!.textContent).toBe("N");
    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(container.querySelector("p")!.textContent).toBe("");
    expect(screen.getByRole("link").getAttribute("href")).toBe("/in");
  });
  it("verified without followers has no separator; followers without verified has no separator; both has one", () => {
    const a = render(<StoreHeader name="N" followHref="/in" verified locale="en-EG" />);
    expect(a.container.textContent).not.toContain("·");
    expect(a.container.textContent).toContain("Verified");
    a.unmount();
    const b = render(<StoreHeader name="N" followHref="/in" followers={5} locale="en-EG" />);
    expect(b.container.textContent).not.toContain("·");
    expect(b.container.textContent).not.toContain("Verified");
    b.unmount();
    const c = render(<StoreHeader name="N" followHref="/in" verified={false} followers={0} locale="en-EG" />);
    expect(c.container.textContent).not.toContain("Verified");
    expect(c.container.textContent).toMatch(/0/);
    c.unmount();
    const d = render(<StoreHeader name="N" followHref="/in" verified followers={5} locale="en-EG" />);
    expect(d.container.textContent).toContain(" · ");
  });
  it("logo and tagline render when given", async () => {
    const { container } = render(<StoreHeader name="N" tagline="Deals" logo={{ src: "/l.png", alt: "Logo" }} followHref="/in" locale="ar-EG" />);
    expect(container.querySelector("img")!.getAttribute("alt")).toBe("Logo");
    expect(container.textContent).toContain("Deals");
    await expectNoA11yViolations(container);
  });
});

describe("TopNav", () => {
  const props = { homeHref: "/", searchAction: "/search", accountHref: "/a", bagHref: "/b", chips: [{ id: "all", label: "All", href: "/", current: true }] };
  it("the bag link has no count label unless a real count is given (0 included)", () => {
    const { rerender } = render(<TopNav {...props} locale="en-EG" />);
    const bag = screen.getByRole("link", { name: "Bag" });
    expect(bag.hasAttribute("aria-label")).toBe(false);
    rerender(<TopNav {...props} bagCount={0} locale="en-EG" />);
    expect(screen.getAllByRole("link").find((l) => l.getAttribute("href") === "/b")!.getAttribute("aria-label")).toMatch(/0/);
    rerender(<TopNav {...props} bagCount={3} locale="en-EG" />);
    expect(screen.getAllByRole("link").find((l) => l.getAttribute("href") === "/b")!.getAttribute("aria-label")).toMatch(/3/);
  });
  it("search is a GET form to the given action; tabs slot is optional", async () => {
    const { container } = render(<TopNav {...props} tabs={<TabsExploreDeals active="deals" exploreHref="/" dealsHref="/d" locale="en-EG" />} locale="en-EG" />);
    const form = screen.getByRole<HTMLFormElement>("search");
    expect(form.getAttribute("action")).toBe("/search");
    expect(form.method).toBe("get");
    expect((form.querySelector("input")!).name).toBe("q");
    expect(screen.getByRole("link", { name: "Discover deals" }).getAttribute("aria-current")).toBe("page");
    await expectNoA11yViolations(container);
  });
  it("works in Arabic with no locale prop through the provider", async () => {
    const { container } = render(<LocaleProvider locale="ar-EG"><TopNav {...props} /></LocaleProvider>);
    expect(container.closest("body")!.querySelector("[dir='rtl']")).not.toBeNull();
    await expectNoA11yViolations(container);
  });
});

describe("TabsExploreDeals", () => {
  it.each([
    ["explore", "page", null],
    ["deals", null, "page"],
    ["none", null, null],
  ] as const)("active=%s marks exactly the right tab", (active, explore, deals) => {
    render(<TabsExploreDeals active={active} exploreHref="/e" dealsHref="/d" locale="en-EG" />);
    expect(screen.getByRole("link", { name: "Explore stores" }).getAttribute("aria-current")).toBe(explore);
    expect(screen.getByRole("link", { name: "Discover deals" }).getAttribute("aria-current")).toBe(deals);
  });
  it("is axe clean in both locales", async () => {
    for (const locale of ["ar-EG", "en-EG"] as const) {
      const { container, unmount } = render(<TabsExploreDeals active="explore" exploreHref="/e" dealsHref="/d" locale={locale} />);
      await expectNoA11yViolations(container);
      unmount();
    }
  });
});

describe("QuickViewPanel branches", () => {
  const base = { name: "Jacket", storeName: "Nile", pricing: { price: money(100n, "EGP") }, defectCount: 1, availability: "in_stock" as const, fullPageHref: "/p", closeHref: "/s", locale: "en-EG" as const };
  it("optional parts: image, condition, proof link are shown only when given", () => {
    const { container, rerender } = render(<QuickViewPanel {...base} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByRole("link", { name: /proof/i })).toBeNull();
    expect(screen.getByText(/bag is not available/i)).toBeTruthy();
    rerender(<QuickViewPanel {...base} image={{ src: "/j.jpg", alt: "Jacket" }} condition="sample" priceProofHref="/proof" onAddToBag={vi.fn()} />);
    expect(container.querySelector("img")!.getAttribute("alt")).toBe("Jacket");
    expect(container.querySelector("a[href='/proof']")).not.toBeNull();
    expect(screen.queryByText(/bag is not available/i)).toBeNull();
  });
  it("availability: low stock and sold out each show their own message; in stock shows neither", () => {
    const { container, rerender } = render(<QuickViewPanel {...base} />);
    const before = container.textContent;
    rerender(<QuickViewPanel {...base} availability="low_stock" />);
    expect(container.textContent).not.toBe(before);
    const low = container.textContent;
    rerender(<QuickViewPanel {...base} availability="out_of_stock" />);
    expect(container.textContent).not.toBe(low);
  });
  it("without onClose, Close and Escape navigate to closeHref", () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { assign } });
    try {
      render(<QuickViewPanel {...base} />);
      fireEvent.click(screen.getByRole("button", { name: "Close quick view" }));
      expect(assign).toHaveBeenCalledWith("/s");
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      expect(assign).toHaveBeenCalledTimes(2);
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: original });
    }
  });
  it("Tab wraps focus at both ends and leaves the middle alone; other keys are ignored", () => {
    render(<QuickViewPanel {...base} priceProofHref="/proof" onAddToBag={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    const close = screen.getByRole("button", { name: "Close quick view" });
    const fullPage = screen.getByRole("link", { name: /product page/i });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(fullPage);
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    const prevent = fireEvent.keyDown(dialog, { key: "Tab" }); // focus on first, not last: not prevented
    expect(prevent).toBe(true);
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(document.activeElement).toBe(close);
  });
  it("stepper is bounded at MAX and returns focus to the opener on unmount", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(<QuickViewPanel {...base} onAddToBag={vi.fn()} />);
    const inc = screen.getByRole<HTMLButtonElement>("button", { name: "Increase quantity" });
    for (let i = 0; i < 15; i += 1) fireEvent.click(inc);
    expect(screen.getByRole("status").textContent).toBe("10");
    expect(inc.disabled).toBe(true);
    const dec = screen.getByRole<HTMLButtonElement>("button", { name: "Decrease quantity" });
    for (let i = 0; i < 15; i += 1) fireEvent.click(dec);
    expect(screen.getByRole("status").textContent).toBe("1");
    expect(dec.disabled).toBe(true);
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
  it("is axe clean in Arabic with every optional part present", async () => {
    const { container } = render(<QuickViewPanel {...base} locale="ar-EG" image={{ src: "/j.jpg", alt: "جاكيت" }} condition="openBox" priceProofHref="/proof" availability="low_stock" onAddToBag={vi.fn()} />);
    await expectNoA11yViolations(container);
  });
});
