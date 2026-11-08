import { money } from "@outlet/money";
import { fireEvent, render, screen, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Gallery } from "../examples/Gallery.js";
import {
  Button, DefectCard, Field, FreeDeliveryProgress, LocaleProvider, LocaleSwitch, PriceBlock, ProductCard, Skeleton, verifiedPercent,
  type VerifiedEvidence,
} from "../src/index.js";
import { DiscountBandLabel, ProductCubby, StorefrontCard3D } from "../src/index.js";
import { expectNoA11yViolations } from "./axe.js";

const LOCALES = ["ar-EG", "en-EG"] as const;
const evidence: VerifiedEvidence = { claimAllowed: true, reference: money(200_000n, "EGP"), evidenceIds: ["ev-1"], lowestIn30Days: true };
const pic = { src: "/x.avif", alt: "Black jacket, front view" };

describe("PriceBlock evidence rule", () => {
  it("shows % off, strike-through and badges only with verified evidence", () => {
    const { container } = render(<PriceBlock price={money(80_000n, "EGP")} verified={evidence} locale="en-EG" />);
    expect(container.querySelector("del")).not.toBeNull();
    expect(container.textContent).toContain("60% off");
    expect(container.textContent).toContain("Verified discount");
    expect(container.textContent).toContain("Lowest price in 30 days");
    expect(container.textContent).toContain("EGP 800");
  });

  it("renders Arabic digits and labels", () => {
    const { container } = render(<PriceBlock price={money(80_000n, "EGP")} verified={evidence} locale="ar-EG" />);
    expect(container.textContent).toContain("خصم ٦٠٪");
    expect(container.textContent).toContain("٨٠٠ ج.م");
  });

  it("never renders a % or strike-through without evidence", () => {
    for (const kind of [undefined, "plain", "launch", "great"] as const) {
      for (const locale of LOCALES) {
        const props = kind === undefined ? {} : { priceKind: kind };
        const { container, unmount } = render(<PriceBlock price={money(80_000n, "EGP")} locale={locale} {...props} />);
        expect(container.querySelector("del, s, strike")).toBeNull();
        expect(container.textContent).not.toMatch(/[%٪]/);
        unmount();
      }
    }
  });

  it("labels launch and great prices without a percentage", () => {
    render(<PriceBlock price={money(80_000n, "EGP")} priceKind="launch" locale="en-EG" />);
    expect(screen.getByText("Launch price")).toBeTruthy();
    render(<PriceBlock price={money(80_000n, "EGP")} priceKind="great" locale="en-EG" />);
    expect(screen.getByText("Great price")).toBeTruthy();
  });

  it("degrades to a plain price when evidence cannot support a claim", () => {
    const bad: VerifiedEvidence[] = [
      { ...evidence, reference: money(81_000n, "EGP") }, // 1% only, below the 5% floor
      { ...evidence, reference: money(80_000n, "EGP") }, // not higher
      { ...evidence, reference: money(70_000n, "EGP") }, // reference lower than price
      { ...evidence, reference: money(200_000n, "SAR") }, // currency mismatch
      { ...evidence, reference: money(0n, "EGP") },
      { ...evidence, evidenceIds: [] as unknown as VerifiedEvidence["evidenceIds"] },
    ];
    for (const v of bad) {
      const { container, unmount } = render(<PriceBlock price={money(80_000n, "EGP")} verified={v} locale="en-EG" />);
      expect(container.querySelector("del")).toBeNull();
      expect(container.textContent).not.toContain("%");
      expect(container.textContent).toContain("EGP 800");
      unmount();
    }
  });

  it("computes the percentage with floor on integer piastres", () => {
    expect(verifiedPercent(money(66_700n, "EGP"), { ...evidence, reference: money(100_000n, "EGP") })).toBe(33);
    expect(verifiedPercent(money(95_000n, "EGP"), { ...evidence, reference: money(100_000n, "EGP") })).toBe(5);
    expect(verifiedPercent(money(95_001n, "EGP"), { ...evidence, reference: money(100_000n, "EGP") })).toBeNull();
  });

  it("makes an unverified % impossible at the type level", () => {
    const p = money(1n, "EGP");
    // The assertions are compile-time; the renders are discarded.
    const cases = [
      // @ts-expect-error no percentage prop exists
      <PriceBlock price={p} percentOff={60} />,
      // @ts-expect-error no reference-price prop exists
      <PriceBlock price={p} reference={p} />,
      // @ts-expect-error evidence must carry evidenceIds and claimAllowed
      <PriceBlock price={p} verified={{ reference: p }} />,
      // @ts-expect-error claimAllowed must be literally true
      <PriceBlock price={p} verified={{ claimAllowed: false, reference: p, evidenceIds: ["x"] }} />,
      // @ts-expect-error evidenceIds must be non-empty
      <PriceBlock price={p} verified={{ claimAllowed: true, reference: p, evidenceIds: [] }} />,
      // @ts-expect-error a price kind cannot be combined with evidence
      <PriceBlock price={p} verified={evidence} priceKind="launch" />,
    ];
    expect(cases).toHaveLength(6);
  });

  it("shows a skeleton while loading", () => {
    render(<PriceBlock price={money(1n, "EGP")} loading />);
    expect(screen.getByRole("status")).toBeTruthy();
  });
});

describe("Skeleton 300 ms rule", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  it("stays invisible until the delay elapses", () => {
    render(<Skeleton locale="en-EG" />);
    const el = screen.getByRole("status");
    expect(el.getAttribute("data-visible")).toBe("false");
    expect(el.textContent).toBe("");
    act(() => { vi.advanceTimersByTime(299); });
    expect(el.getAttribute("data-visible")).toBe("false");
    act(() => { vi.advanceTimersByTime(1); });
    expect(el.getAttribute("data-visible")).toBe("true");
    expect(el.textContent).toBe("Loading…");
  });
  it("never shows if unmounted before the delay, and shows at once with delay 0", () => {
    const { unmount } = render(<Skeleton />);
    unmount();
    act(() => { vi.advanceTimersByTime(1000); });
    render(<Skeleton delayMs={0} />);
    expect(screen.getByRole("status").getAttribute("data-visible")).toBe("true");
  });
});

describe("Button, Field, LocaleSwitch", () => {
  it("Button defaults to type=button and blocks clicks while loading", () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Go</Button>);
    const b = screen.getByRole("button", { name: "Go" });
    expect(b.getAttribute("type")).toBe("button");
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<Button onClick={onClick} loading>Go</Button>);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button").getAttribute("aria-busy")).toBe("true");
  });

  it("Field links label, hint and error; marks optional fields", () => {
    const { rerender } = render(<Field label="Phone" hint="Egyptian number" locale="en-EG" />);
    expect(screen.getByLabelText(/Phone/)).toBeTruthy();
    expect(screen.getByText(/Optional/)).toBeTruthy();
    rerender(<Field label="Phone" hint="Egyptian number" error="Required" required locale="en-EG" />);
    const input = screen.getByLabelText("Phone");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")?.split(" ")).toHaveLength(2);
    expect(screen.getByRole("alert").textContent).toBe("Required");
  });

  it("LocaleSwitch reports the chosen locale and exposes pressed state", () => {
    const onChange = vi.fn();
    render(<LocaleSwitch locale="ar-EG" onChange={onChange} />);
    expect(screen.getByRole("button", { name: "العربية" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    expect(onChange).toHaveBeenCalledWith("en-EG");
  });

  it("LocaleProvider sets lang and dir", () => {
    const { container } = render(<LocaleProvider locale="ar-EG" numerals="latn"><PriceBlock price={money(120_000n, "EGP")} /></LocaleProvider>);
    const wrap = container.firstElementChild;
    expect(wrap?.getAttribute("dir")).toBe("rtl");
    expect(wrap?.getAttribute("lang")).toBe("ar-EG");
    expect(container.textContent).toContain("1,200 ج.م");
  });
});

describe("FreeDeliveryProgress", () => {
  it("shows the remaining amount, then unlocks (spec: 1,950 + 60 EGP)", () => {
    const threshold = money(200_000n, "EGP");
    const { rerender } = render(<FreeDeliveryProgress subtotal={money(195_000n, "EGP")} threshold={threshold} storeName="NOVA" locale="en-EG" />);
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("97");
    expect(bar.getAttribute("aria-valuetext")).toBe("Add EGP 50 from NOVA to get free delivery");
    rerender(<FreeDeliveryProgress subtotal={money(201_000n, "EGP")} threshold={threshold} storeName="NOVA" locale="en-EG" />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
    expect(screen.getByText("Free delivery unlocked from NOVA")).toBeTruthy();
  });
  it("Plus and a zero threshold are always unlocked", () => {
    render(<FreeDeliveryProgress subtotal={money(0n, "EGP")} threshold={money(200_000n, "EGP")} storeName="NOVA" isPlus locale="en-EG" />);
    expect(screen.getByText("Free delivery with Plus")).toBeTruthy();
    render(<FreeDeliveryProgress subtotal={money(0n, "EGP")} threshold={money(0n, "EGP")} storeName="NOVA" locale="en-EG" />);
    expect(screen.getAllByRole("progressbar")[1]?.getAttribute("aria-valuenow")).toBe("100");
  });
});

describe("ProductCard", () => {
  const pricing = { price: money(80_000n, "EGP"), verified: evidence };
  it("renders a verified card with a quick-add that has an accessible name", () => {
    const onQuickAdd = vi.fn();
    render(<ProductCard name="Jacket" storeName="NOVA" href="/p/1" image={pic} pricing={pricing} condition="openBox" onQuickAdd={onQuickAdd} locale="en-EG" />);
    expect(screen.getByRole("link", { name: /Jacket/ }).getAttribute("href")).toBe("/p/1");
    expect(screen.getByText("Open box")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add Jacket to bag" }));
    expect(onQuickAdd).toHaveBeenCalled();
  });
  it("renders unverified pricing without any %", () => {
    const { container } = render(<ProductCard name="Jacket" storeName="NOVA" href="/p/1" image={pic} pricing={{ price: money(80_000n, "EGP"), priceKind: "launch" }} locale="en-EG" />);
    expect(container.textContent).not.toContain("%");
    expect(container.textContent).toContain("Launch price");
  });
  it("covers loading, empty and error states", () => {
    const onRetry = vi.fn();
    const base = { name: "Jacket", storeName: "NOVA", href: "/p/1", image: pic, pricing, locale: "en-EG" } as const;
    const { rerender } = render(<ProductCard {...base} state="loading" />);
    expect(screen.getAllByRole("status")).toHaveLength(3);
    rerender(<ProductCard {...base} state="empty" />);
    expect(screen.getByText("Nothing here yet.")).toBeTruthy();
    rerender(<ProductCard {...base} state="error" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalled();
    rerender(<ProductCard {...base} state="error" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("DefectCard", () => {
  it("shows grade, photos, notes and the passport link", () => {
    render(<DefectCard grade="B" photos={[{ src: "/d.avif", alt: "Scratch on the side" }]} description="Minor scratch" location="Right panel" doesNotAffectOperation passportUrl="/passport/1" passportQrSrc="/qr.png" locale="en-EG" />);
    expect(screen.getByText("Grade B")).toBeTruthy();
    expect(screen.getByAltText("Scratch on the side")).toBeTruthy();
    expect(screen.getByText("Defect location: Right panel")).toBeTruthy();
    expect(screen.getByText("Does not affect operation")).toBeTruthy();
    expect(screen.getByAltText("QR code for the product passport")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the product passport" }).getAttribute("href")).toBe("/passport/1");
  });
  it("handles empty photos, no description and rejects unsafe passport URLs", () => {
    render(<DefectCard grade="C" photos={[]} passportUrl="javascript:alert(1)" locale="en-EG" />);
    expect(screen.getByText("No defect photos yet")).toBeTruthy();
    expect(screen.getByText("The seller has not added a description")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
  it("ignores malformed passport URLs", () => {
    render(<DefectCard grade="A" photos={[]} passportUrl="http://[bad" locale="en-EG" />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe.each(LOCALES)("axe (%s)", (locale) => {
  it("Gallery has no violations", async () => {
    const { container } = render(<Gallery locale={locale} onLocale={() => undefined} />);
    await expectNoA11yViolations(container);
  });
  it("each component alone has no violations", async () => {
    const p = money(80_000n, "EGP");
    const items = [
      <PriceBlock key="a" price={p} verified={evidence} locale={locale} />,
      <PriceBlock key="b" price={p} priceKind="launch" locale={locale} />,
      <DefectCard key="c" grade="A" photos={[]} locale={locale} />,
      <FreeDeliveryProgress key="d" subtotal={p} threshold={money(200_000n, "EGP")} storeName="NOVA" locale={locale} />,
      <ProductCard key="e" name="Jacket" storeName="NOVA" href="/p" image={pic} pricing={{ price: p }} onQuickAdd={() => undefined} locale={locale} />,
      <ProductCard key="f" name="Jacket" storeName="NOVA" href="/p" image={pic} pricing={{ price: p }} state="error" onRetry={() => undefined} locale={locale} />,
      <Button key="g">Go</Button>,
      <Field key="h" label="Phone" error="Required" locale={locale} />,
      <Skeleton key="i" delayMs={0} locale={locale} />,
      <LocaleSwitch key="j" locale={locale} onChange={() => undefined} />,
    ];
    for (const item of items) {
      const { container, unmount } = render(<main>{item}</main>);
      await expectNoA11yViolations(container);
      unmount();
    }
  });
});

describe("shelf components", () => {
  const pic = { src: "/x.avif", alt: "Front view" };
  it("DiscountBandLabel renders verified bands and refuses invalid ones", () => {
    const { container, rerender } = render(<DiscountBandLabel highPercent={70} lowPercent={60} verified locale="en-EG" />);
    expect(container.textContent).toBe("70%–60% OFF");
    rerender(<DiscountBandLabel highPercent={3} lowPercent={2} verified locale="en-EG" />);
    expect(container.textContent).toBe("");
    // @ts-expect-error a band needs the verified flag
    render(<DiscountBandLabel highPercent={70} lowPercent={60} />);
  });
  it.each(LOCALES)("cubby and storefront have accessible names and pass axe (%s)", async (locale) => {
    const { container } = render(
      <main>
        <ProductCubby name="Jacket" href="/p" image={pic} pricing={{ price: money(50_000n, "EGP") }} onQuickAdd={() => undefined} locale={locale} />
        <StorefrontCard3D storeName="NOVA" category="Fashion" href="/s" image={pic} locale={locale} />
      </main>,
    );
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBeTruthy();
    expect(container.querySelector("a.storefront, a[class*=storefront]")?.getAttribute("aria-label")).toBeTruthy();
    await expectNoA11yViolations(container);
  });
});
