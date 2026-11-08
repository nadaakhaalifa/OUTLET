import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); }, usePathname: () => "/eg-ar" }));
vi.mock("next/headers", () => ({ headers: () => Promise.resolve(new Headers({ "x-nonce": "n0nce" })), cookies: () => Promise.resolve({ get: () => undefined }) }));

const { default: Login, generateMetadata: loginMeta } = await import("../src/app/[segment]/login/page");
const { default: Bag, generateMetadata: bagMeta } = await import("../src/app/[segment]/bag/page");
const { default: Checkout } = await import("../src/app/[segment]/checkout/page");
const { default: Account } = await import("../src/app/[segment]/account/page");
const { default: Orders } = await import("../src/app/[segment]/orders/[id]/page");

const seg = (segment: string) => ({ params: Promise.resolve({ segment }) });
const html = async (el: Promise<React.ReactElement>) => renderToStaticMarkup(await el);

describe("shopper pages", () => {
  it.each([["eg-ar", "تسجيل الدخول", "rtl"], ["eg-en", "Sign in", "ltr"]])("login renders the heading and OTP form in %s", async (segment, title) => {
    const out = await html(Login({ ...seg(segment), searchParams: Promise.resolve({}) }));
    expect(out).toContain(`id="login-title"`);
    expect(out).toContain(title);
    expect(out).not.toContain("style=");
    expect(out).not.toContain("checked");
  });
  it("login passes only a string next through and the pages are noindex", async () => {
    const out = await html(Login({ ...seg("eg-en"), searchParams: Promise.resolve({ next: ["a", "b"] }) }));
    expect(out).toContain("Mobile number");
    expect((await loginMeta(seg("eg-en"))).robots).toEqual({ index: false, follow: false });
    expect((await bagMeta(seg("eg-ar"))).robots).toEqual({ index: false, follow: false });
  });
  it.each([[Bag], [Checkout], [Account]])("renders a titled section in Arabic", async (Page) => {
    const out = await html(Page(seg("eg-ar")));
    expect(out).toContain("<h1");
    expect(out).not.toContain("style=");
  });
  it("order page validates the id and renders the status shell", async () => {
    const out = await html(Orders({ params: Promise.resolve({ segment: "eg-en", id: "0b7d1f4e-0000-4000-8000-0000000000e1" }) }));
    expect(out).toContain("Order status");
    await expect(Orders({ params: Promise.resolve({ segment: "eg-en", id: "../x" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(Orders({ params: Promise.resolve({ segment: "xx", id: "0b7d1f4e-0000-4000-8000-0000000000e1" }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
