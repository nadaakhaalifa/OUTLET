import { money } from "@outlet/money";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Breadcrumb, CategoryChips, DiscountBandShelf, QuickViewPanel, ShelfWall, StoreCarousel, StoreHeader, StorefrontGrid, TabsExploreDeals, TopNav,
  type CubbyItem, type StorefrontItem, type VerifiedEvidence,
} from "../src/index.js";
import { expectNoA11yViolations } from "./axe.js";

const LOCALES = ["ar-EG", "en-EG"] as const;
const stores: StorefrontItem[] = Array.from({ length: 8 }, (_, i) => ({ key: `s${String(i)}`, storeName: `Store ${String(i)}`, category: "Fashion", href: `/eg-en/stores/store-${String(i)}` }));
const cubbies: CubbyItem[] = Array.from({ length: 7 }, (_, i) => ({ key: `p${String(i)}`, name: `Item ${String(i)}`, href: `/p/${String(i)}`, pricing: { price: money(10_000n + BigInt(i), "EGP") } }));
const evidence: VerifiedEvidence = { claimAllowed: true, reference: money(40_000n, "EGP"), evidenceIds: ["ev"] };

beforeEach(() => {
  Element.prototype.scrollTo = vi.fn();
});

describe.each(LOCALES)("village components (%s)", (locale) => {
  it("StorefrontGrid: placeholder facades, rows as carousels, axe clean, no inline styles", async () => {
    const { container } = render(<StorefrontGrid stores={stores} locale={locale} />);
    expect(container.querySelectorAll('[aria-roledescription="carousel"]')).toHaveLength(2); // 8 stores -> 6 + 2
    expect(container.querySelector("[style]")).toBeNull();
    await expectNoA11yViolations(container);
  });

  it("ShelfWall + DiscountBandShelf + chrome are axe clean", async () => {
    const { container } = render(
      <div>
        <ShelfWall items={cubbies} locale={locale} />
        <DiscountBandShelf band={{ highPercent: 70, lowPercent: 60, verified: true }} items={cubbies} locale={locale} />
        <StoreHeader name="Nile Outlet" tagline="Tagline" verified followers={12} followHref="/account" locale={locale} />
        <Breadcrumb label="crumbs" items={[{ label: "Stores", href: "/" }, { label: "Nile" }]} />
        <TopNav homeHref="/" searchAction="/" accountHref="/a" bagHref="/b" chips={[{ id: "all", label: "All", href: "/", current: true }]} tabs={<TabsExploreDeals active="explore" exploreHref="/" dealsHref="/d" locale={locale} />} locale={locale} />
        <CategoryChips label="cats" items={[{ id: "a", label: "A", href: "/a" }]} />
      </div>,
    );
    await expectNoA11yViolations(container);
  });

  it("QuickViewPanel is a labelled modal dialog and axe clean", async () => {
    const { container } = render(
      <QuickViewPanel name="Jacket" storeName="Nile" pricing={{ price: money(30_000n, "EGP"), verified: evidence }} condition="openBox" defectCount={0} availability="in_stock" fullPageHref="/p/1" closeHref="/s" locale={locale} />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).not.toBeNull();
    await expectNoA11yViolations(container);
  });
});

describe("StoreCarousel", () => {
  it("scrolls with arrow keys and flips direction in RTL", () => {
    const scrollTo = vi.fn();
    Element.prototype.scrollTo = scrollTo;
    for (const [locale, sign] of [["en-EG", 1], ["ar-EG", -1]] as const) {
      scrollTo.mockClear();
      const { container, unmount } = render(
        <StoreCarousel label="x" locale={locale}>{[<span key="a">a</span>, <span key="b">b</span>]}</StoreCarousel>,
      );
      const vp = container.querySelector("ul") as HTMLElement;
      Object.defineProperty(vp, "clientWidth", { configurable: true, value: 100 });
      Object.defineProperty(vp, "scrollWidth", { configurable: true, value: 300 });
      fireEvent.scroll(vp); // measures -> 3 pages
      fireEvent.keyDown(vp, { key: sign === 1 ? "ArrowRight" : "ArrowLeft" });
      expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ left: sign * 100 }));
      unmount();
    }
  });
});

describe("QuickViewPanel behaviour", () => {
  it("ESC closes, focus starts on close and is trapped, add is disabled without a callback", () => {
    const onClose = vi.fn();
    render(<QuickViewPanel name="J" storeName="N" pricing={{ price: money(100n, "EGP") }} defectCount={2} availability="in_stock" fullPageHref="/p" closeHref="/s" onClose={onClose} locale="en-EG" />);
    const close = screen.getByRole("button", { name: "Close quick view" });
    expect(document.activeElement).toBe(close);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Add to bag" }).disabled).toBe(true);
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("quantity stepper is bounded and Add passes the quantity", () => {
    const onAdd = vi.fn();
    render(<QuickViewPanel name="J" storeName="N" pricing={{ price: money(100n, "EGP") }} defectCount={0} availability="low_stock" fullPageHref="/p" closeHref="/s" onAddToBag={onAdd} locale="en-EG" />);
    const dec = screen.getByRole<HTMLButtonElement>("button", { name: "Decrease quantity" });
    expect(dec.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Increase quantity" }));
    fireEvent.click(screen.getByRole("button", { name: "Add to bag" }));
    expect(onAdd).toHaveBeenCalledWith(2);
  });
  it("sold out disables Add even with a callback", () => {
    render(<QuickViewPanel name="J" storeName="N" pricing={{ price: money(100n, "EGP") }} defectCount={0} availability="out_of_stock" fullPageHref="/p" closeHref="/s" onAddToBag={vi.fn()} locale="en-EG" />);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Add to bag" }).disabled).toBe(true);
  });
});

describe("DiscountBandShelf honesty", () => {
  it("shows no band label unless verified", () => {
    const { container } = render(<DiscountBandShelf band={{ highPercent: 70, lowPercent: 60, verified: false }} items={cubbies} locale="en-EG" />);
    expect(container.textContent).not.toMatch(/%/);
    expect(container.textContent).toContain("Products at plain prices");
    const none = render(<DiscountBandShelf items={cubbies} locale="en-EG" />);
    expect(none.container.textContent).not.toMatch(/OFF/);
  });
  it("shows the band when verified", () => {
    const { container } = render(<DiscountBandShelf band={{ highPercent: 70, lowPercent: 60, verified: true }} items={cubbies} locale="en-EG" />);
    expect(container.textContent).toContain("70%–60% OFF");
  });
});
