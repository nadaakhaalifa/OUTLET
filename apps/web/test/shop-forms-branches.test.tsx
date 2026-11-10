import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Locale } from "@outlet/i18n";
import { LoginForm } from "../src/components/shop/LoginForm";
import { AddressForm } from "../src/components/shop/AddressForm";
import { ApiProblem } from "../src/lib/client-api";
import { address, consent, geo, stubApi } from "./shop-fixtures";

afterEach(() => { vi.useRealTimers(); });
const EN: Locale = "en-EG";
const NOW = () => new Date("2026-11-08T10:00:00Z");
const noPasskey = { supported: () => false, authenticate: vi.fn() };
const type = (label: RegExp | string, value: string) => { fireEvent.change(screen.getByLabelText(label), { target: { value } }); };
const click = (name: string) => { fireEvent.click(screen.getByRole("button", { name })); };
const challenge = { challengeId: "c1", resendAfterS: 30 };
const toCode = async (api: ReturnType<typeof stubApi>, navigate = vi.fn(), locale: Locale = EN) => {
  render(<LoginForm locale={locale} api={api} navigate={navigate} now={NOW} webauthn={noPasskey} />);
  type(/Mobile number/, "01012345678");
  click("Send code");
  await screen.findByLabelText(/Verification code/);
  return navigate;
};

describe("LoginForm error and recovery branches", () => {
  it("a 429 on sending the code starts the cooldown from Retry-After and shows the rate-limit message", async () => {
    const api = stubApi({ requestOtp: vi.fn().mockRejectedValue(new ApiProblem(429, "rate-limited", 45, null)) });
    render(<LoginForm locale={EN} api={api} navigate={vi.fn()} webauthn={noPasskey} />);
    type(/Mobile number/, "01012345678");
    click("Send code");
    expect((await screen.findByRole("alert")).textContent).toBe("Too many attempts. Try again in 45 s.");
    expect(screen.queryByLabelText(/Verification code/)).toBeNull();
  });
  it("a 429 without Retry-After falls back to 60 seconds", async () => {
    const api = stubApi({ requestOtp: vi.fn().mockRejectedValue(new ApiProblem(429, "rate-limited", null, null)) });
    render(<LoginForm locale={EN} api={api} navigate={vi.fn()} webauthn={noPasskey} />);
    type(/Mobile number/, "01012345678");
    click("Send code");
    expect((await screen.findByRole("alert")).textContent).toBe("Too many attempts. Try again in 60 s.");
  });
  it.each([["under-age"], ["age-blocked"]])("a %s problem from the server on verify is shown as the under-18 rejection", async (kind) => {
    const api = stubApi({ requestOtp: vi.fn().mockResolvedValue({ challengeId: "c1", resendAfterS: 30 }), verifyOtp: vi.fn().mockRejectedValue(new ApiProblem(403, kind, null, null)) });
    render(<LoginForm locale={EN} api={api} navigate={vi.fn()} now={NOW} webauthn={noPasskey} />);
    click("New here? Create an account");
    type(/Mobile number/, "01012345678");
    type(/Date of birth/, "1990-01-01");
    fireEvent.click(screen.getByRole("checkbox"));
    click("Send code");
    await screen.findByLabelText(/Verification code/);
    type(/Verification code/, "123456");
    click("Verify");
    expect((await screen.findByRole("alert")).textContent).toBe("This service is for people aged 18 and over.");
  });
  it("otp-locked and rate-limited problems show the Retry-After wait", async () => {
    for (const [t, secs] of [["otp-locked", 300], ["rate-limited", 7]] as const) {
      const api = stubApi({ requestOtp: vi.fn().mockRejectedValue(new ApiProblem(429, t, secs, null)) });
      const { unmount } = render(<LoginForm locale={EN} api={api} navigate={vi.fn()} webauthn={noPasskey} />);
      type(/Mobile number/, "01012345678");
      click("Send code");
      expect((await screen.findByRole("alert")).textContent).toBe(`Too many attempts. Try again in ${String(secs)} s.`);
      unmount();
    }
  });
  it("an unexpected failure sends a generic error and keeps the form usable", async () => {
    const api = stubApi({ requestOtp: vi.fn().mockRejectedValue(new Error("network")) });
    render(<LoginForm locale={EN} api={api} navigate={vi.fn()} webauthn={noPasskey} />);
    type(/Mobile number/, "01012345678");
    click("Send code");
    expect((await screen.findByRole("alert")).textContent).toBe("Something went wrong. Please try again.");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send code" }).disabled).toBe(false);
  });
  it("the resend button is disabled during the cooldown, then re-requests a code and restarts the timer; change phone goes back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const requestOtp = vi.fn().mockResolvedValue({ challengeId: "c1", resendAfterS: 2 });
    await toCode(stubApi({ requestOtp }));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Resend in 2 s" }).disabled).toBe(true);
    for (let i = 0; i < 2; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    const resend = screen.getByRole<HTMLButtonElement>("button", { name: "Resend code" });
    expect(resend.disabled).toBe(false);
    fireEvent.click(resend);
    await waitFor(() => { expect(requestOtp).toHaveBeenCalledTimes(2); });
    await screen.findByRole("button", { name: /Resend in/ });
    click("Change number");
    expect(screen.getByLabelText(/Mobile number/)).toBeTruthy();
  });
  it("toggles between register and sign-in and clears the previous error", async () => {
    render(<LoginForm locale={EN} api={stubApi()} navigate={vi.fn()} webauthn={noPasskey} />);
    click("Send code");
    await screen.findByRole("alert");
    click("New here? Create an account");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText(/Date of birth/)).toBeTruthy();
    click("I already have an account");
    expect(screen.queryByLabelText(/Date of birth/)).toBeNull();
  });
  it("a new user whose consent list is empty, or fails to load, goes straight on", async () => {
    for (const listConsents of [vi.fn().mockResolvedValue([]), vi.fn().mockRejectedValue(new Error("x"))]) {
      const navigate = await toCode(stubApi({ requestOtp: vi.fn().mockResolvedValue(challenge), verifyOtp: vi.fn().mockResolvedValue({ isNewUser: true }), listConsents }));
      type(/Verification code/, "123456");
      click("Verify");
      await waitFor(() => { expect(navigate).toHaveBeenCalledWith("/eg-en"); });
      document.body.innerHTML = "";
    }
  });
  it("consents: unticking removes the purpose, nothing ticked saves nothing, a save failure shows an error and does not navigate", async () => {
    const patchConsents = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue([]);
    const navigate = await toCode(stubApi({
      requestOtp: vi.fn().mockResolvedValue(challenge), verifyOtp: vi.fn().mockResolvedValue({ isNewUser: true }),
      listConsents: vi.fn().mockResolvedValue([consent("analytics"), consent("marketing_push")]), patchConsents,
    }));
    type(/Verification code/, "123456");
    click("Verify");
    await screen.findByText("Your privacy choices");
    const analytics = screen.getByLabelText("Consent analytics");
    fireEvent.click(analytics);
    fireEvent.click(analytics);
    expect((analytics as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByLabelText("Consent marketing_push"));
    click("Save and continue");
    expect((await screen.findByRole("alert")).textContent).toBe("Something went wrong. Please try again.");
    expect(navigate).not.toHaveBeenCalled();
    expect(patchConsents).toHaveBeenCalledWith([{ code: "marketing_push", version: 3, granted: true }]);
    fireEvent.click(screen.getByLabelText("Consent marketing_push"));
    click("Save and continue");
    await waitFor(() => { expect(navigate).toHaveBeenCalledWith("/eg-en"); });
    expect(patchConsents).toHaveBeenCalledTimes(1); // second save had nothing ticked, so no patch call
  });
  it("Arabic locale shows the Arabic consent text, not the English one", async () => {
    render(<LoginForm locale="ar-EG" api={stubApi({
      requestOtp: vi.fn().mockResolvedValue(challenge), verifyOtp: vi.fn().mockResolvedValue({ isNewUser: true }), listConsents: vi.fn().mockResolvedValue([consent("analytics")]),
    })} navigate={vi.fn()} now={NOW} webauthn={noPasskey} />);
    fireEvent.change(screen.getByRole<HTMLInputElement>("textbox"), { target: { value: "01012345678" } });
    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => { expect(document.querySelector("[autocomplete=one-time-code]")).not.toBeNull(); });
    fireEvent.change(document.querySelector("[autocomplete=one-time-code]")!, { target: { value: "123456" } });
    fireEvent.submit(document.querySelector("form")!);
    expect(await screen.findByText("موافقة analytics")).toBeTruthy();
    expect(screen.queryByText("Consent analytics")).toBeNull();
  });
  it("a 429 during passkey sign-in surfaces the rate limit", async () => {
    const api = stubApi({ passkeyOptions: vi.fn().mockRejectedValue(new ApiProblem(429, "rate-limited", 9, null)) });
    render(<LoginForm locale={EN} api={api} navigate={vi.fn()} webauthn={{ supported: () => true, authenticate: vi.fn() }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with a passkey" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Too many attempts. Try again in 9 s.");
  });
  it("a passkey sign-in for a new user continues to consents", async () => {
    const api = stubApi({
      passkeyOptions: vi.fn().mockResolvedValue({ challengeId: "pc", publicKey: {} }), passkeyVerify: vi.fn().mockResolvedValue({ isNewUser: true }),
      listConsents: vi.fn().mockResolvedValue([consent("analytics")]),
    });
    render(<LoginForm locale={EN} api={api} navigate={vi.fn()} webauthn={{ supported: () => true, authenticate: vi.fn().mockResolvedValue({}) }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with a passkey" }));
    await screen.findByText("Your privacy choices");
  });
});

describe("AddressForm", () => {
  const areas = {
    gov: [geo("g1", "governorate", "القاهرة")],
    city: [geo("c1", "city", "مدينة نصر", "g1")],
    district: [geo("d1", "district", "الحي الأول", "c1")],
  };
  const geoApi = (over: Parameters<typeof stubApi>[0] = {}, hasDistricts = false) => stubApi({
    geoAreas: vi.fn((level: "governorate" | "city" | "district") => Promise.resolve(level === "district" && !hasDistricts ? [] : areas[level === "governorate" ? "gov" : level])),
    ...over,
  });
  const fill = async (landmark: string, opts: { district?: boolean } = {}) => {
    type("Recipient name", "منى");
    type("Recipient mobile", "01012345678");
    await screen.findByRole("option", { name: "القاهرة" });
    type("Governorate", "g1");
    await screen.findByRole("option", { name: "مدينة نصر" });
    type("City", "c1");
    if (opts.district) { await screen.findByRole("option", { name: "الحي الأول" }); type("District", "d1"); }
    type("Street", "شارع النيل");
    type("Building", "12");
    if (landmark !== "") type(/Landmark/, landmark);
  };

  it("COD-style addresses need a landmark: submit is refused locally without it", async () => {
    const api = geoApi();
    render(<AddressForm locale={EN} api={api} onSaved={vi.fn()} />);
    await fill("");
    click("Save address");
    expect((await screen.findByRole("alert")).textContent).toBe("Check the address details.");
    expect(api.createAddress).not.toHaveBeenCalled();
  });
  it("whitespace-only landmark is also refused", async () => {
    const api = geoApi();
    render(<AddressForm locale={EN} api={api} onSaved={vi.fn()} />);
    await fill("   ");
    click("Save address");
    await screen.findByRole("alert");
    expect(api.createAddress).not.toHaveBeenCalled();
  });
  it("an invalid phone is refused with the phone message", async () => {
    const api = geoApi();
    render(<AddressForm locale={EN} api={api} onSaved={vi.fn()} />);
    await fill("جنب الصيدلية");
    type("Recipient mobile", "123");
    click("Save address");
    expect((await screen.findByRole("alert")).textContent).toBe("Enter a valid Egyptian mobile number.");
    expect(api.createAddress).not.toHaveBeenCalled();
  });
  it("when districts exist one must be chosen, and the chosen district is sent with trimmed fields", async () => {
    const created = address();
    const api = geoApi({ createAddress: vi.fn().mockResolvedValue(created) }, true);
    const onSaved = vi.fn();
    render(<AddressForm locale={EN} api={api} onSaved={onSaved} />);
    await fill(" جنب الصيدلية ");
    type(/Floor/, " 3 ");
    click("Save address");
    await screen.findByRole("alert");
    expect(api.createAddress).not.toHaveBeenCalled();
    await screen.findByRole("option", { name: "الحي الأول" });
    type("District", "d1");
    click("Save address");
    await waitFor(() => { expect(onSaved).toHaveBeenCalledWith(created); });
    expect(api.createAddress).toHaveBeenCalledWith(expect.objectContaining({ districtId: "d1", landmark: "جنب الصيدلية", floor: "3", apartment: "", phoneE164: "+201012345678" }));
  });
  it("a failed save shows the error, keeps the typed values and re-enables submit", async () => {
    const api = geoApi({ createAddress: vi.fn().mockRejectedValue(new ApiProblem(422, "x", null, null)) });
    const onSaved = vi.fn();
    render(<AddressForm locale={EN} api={api} onSaved={onSaved} />);
    await fill("جنب الصيدلية");
    click("Save address");
    expect((await screen.findByRole("alert")).textContent).toBe("Check the address details.");
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByLabelText<HTMLInputElement>("Street").value).toBe("شارع النيل");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save address" }).disabled).toBe(false);
  });
  it("a failing governorate or city lookup shows a generic error; city stays disabled until a governorate is chosen", async () => {
    const api = stubApi({ geoAreas: vi.fn().mockRejectedValue(new Error("down")) });
    render(<AddressForm locale={EN} api={api} onSaved={vi.fn()} />);
    expect((await screen.findByRole("alert")).textContent).toBe("Something went wrong. Please try again.");
    expect(screen.getByLabelText<HTMLSelectElement>("City").disabled).toBe(true);
  });
  it("English labels are used for English locale when a name_en exists", async () => {
    const api = stubApi({ geoAreas: vi.fn().mockResolvedValue([{ ...geo("g1", "governorate", "القاهرة"), name_en: "Cairo" }]) });
    render(<AddressForm locale={EN} api={api} onSaved={vi.fn()} />);
    expect(await screen.findByRole("option", { name: "Cairo" })).toBeTruthy();
  });
  it("a failing district lookup falls back to using the city as the district", async () => {
    const created = address();
    const api = stubApi({
      geoAreas: vi.fn((level: string) => (level === "district" ? Promise.reject(new Error("x")) : Promise.resolve(level === "governorate" ? areas.gov : areas.city))),
      createAddress: vi.fn().mockResolvedValue(created),
    });
    render(<AddressForm locale={EN} api={api} onSaved={vi.fn()} />);
    await fill("ل");
    click("Save address");
    await waitFor(() => { expect(api.createAddress).toHaveBeenCalledWith(expect.objectContaining({ districtId: "c1" })); });
  });
});
