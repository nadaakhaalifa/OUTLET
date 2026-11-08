import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Locale } from "@outlet/i18n";
import { LoginForm, ageOn, type WebAuthnPort } from "../src/components/shop/LoginForm";
import { AccountPanel } from "../src/components/shop/AccountPanel";
import { safeNext } from "../src/components/shop/shared";
import { ApiProblem } from "../src/lib/client-api";
import { expectNoA11yViolations } from "./axe";
import { consent, privacyRequest, session, stubApi } from "./shop-fixtures";

afterEach(() => { vi.useRealTimers(); });
const EN: Locale = "en-EG";
const NOW = () => new Date("2026-11-08T10:00:00Z");
const type = (label: RegExp, value: string) => { fireEvent.change(screen.getByLabelText(label), { target: { value } }); };
const challenge = { challengeId: "c1", resendAfterS: 30 };

describe("ageOn and safeNext", () => {
  it("computes whole years and rejects impossible dates", () => {
    expect(ageOn("2008-11-09", NOW())).toBe(17);
    expect(ageOn("2008-11-08", NOW())).toBe(18);
    expect(ageOn("2008-02-30", NOW())).toBeNull();
    expect(ageOn("nope", NOW())).toBeNull();
    expect(ageOn("2030-01-01", NOW())).toBeNull();
  });
  it("only keeps in-segment relative paths", () => {
    expect(safeNext("/eg-ar/bag", "/eg-ar")).toBe("/eg-ar/bag");
    for (const bad of ["https://evil.test", "//evil.test", "/eg-ar//evil.test", "/other/bag", "/eg-ar/\\x", "/eg-ar/a:b", null, undefined]) expect(safeNext(bad, "/eg-ar")).toBe("/eg-ar");
  });
});

describe("LoginForm", () => {
  it("phone OTP happy path: Eastern digits accepted, resend timer from the API, signed-in users go to next", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = stubApi({ requestOtp: vi.fn().mockResolvedValue(challenge), verifyOtp: vi.fn().mockResolvedValue({ isNewUser: false }) });
    const navigate = vi.fn();
    render(<LoginForm locale={EN} next="/eg-en/bag" api={api} navigate={navigate} webauthn={{ supported: () => false, authenticate: vi.fn() }} />);
    type(/Mobile number/, "٠١٠١٢٣٤٥٦٧٨");
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    await screen.findByText(/We sent a code to/);
    expect(api.requestOtp).toHaveBeenCalledWith("+201012345678", "sign_in");
    expect(screen.getByRole("button", { name: "Resend in 30 s" })).toHaveProperty("disabled", true);
    for (let i = 0; i < 3; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByRole("button", { name: "Resend in 27 s" })).toBeTruthy();
    type(/Verification code/, "١٢٣٤٥٦");
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => { expect(navigate).toHaveBeenCalledWith("/eg-en/bag"); });
    expect(api.verifyOtp).toHaveBeenCalledWith({ challengeId: "c1", phoneE164: "+201012345678", code: "123456" });
  });

  it("rejects a bad number and a short code locally, without calling the API", async () => {
    const api = stubApi();
    render(<LoginForm locale={EN} api={api} navigate={vi.fn()} webauthn={{ supported: () => false, authenticate: vi.fn() }} />);
    type(/Mobile number/, "12345");
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Enter a valid Egyptian mobile number.");
    expect(api.requestOtp).not.toHaveBeenCalled();
  });

  it("shows a wrong-code error and a rate-limit message with the Retry-After seconds", async () => {
    const api = stubApi({
      requestOtp: vi.fn().mockResolvedValue(challenge),
      verifyOtp: vi.fn().mockRejectedValueOnce(new ApiProblem(422, "invalid-otp", null, null)).mockRejectedValueOnce(new ApiProblem(429, "otp-locked", 120, null)),
    });
    render(<LoginForm locale={EN} api={api} navigate={vi.fn()} webauthn={{ supported: () => false, authenticate: vi.fn() }} />);
    type(/Mobile number/, "01012345678");
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    await screen.findByLabelText(/Verification code/);
    type(/Verification code/, "12345");
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The code must be 6 digits.");
    type(/Verification code/, "123456");
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => { expect(screen.getByRole("alert").textContent).toBe("The code is wrong or has expired."); });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => { expect(screen.getByRole("alert").textContent).toBe("Too many attempts. Try again in 120 s."); });
  });

  it("registration needs a valid DOB and the 18+ attestation before any request, then sends dob with the phone on verify", async () => {
    const api = stubApi({
      requestOtp: vi.fn().mockResolvedValue(challenge),
      verifyOtp: vi.fn().mockResolvedValue({ isNewUser: false }), listConsents: vi.fn(),
    });
    const navigate = vi.fn();
    render(<LoginForm locale={EN} api={api} navigate={navigate} now={NOW} webauthn={{ supported: () => false, authenticate: vi.fn() }} />);
    fireEvent.click(screen.getByRole("button", { name: "New here? Create an account" }));
    type(/Mobile number/, "01012345678");
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Enter a valid date of birth.");
    type(/Date of birth/, "2012-05-05");
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    expect((await screen.findByRole("alert")).textContent).toBe("You must confirm you are 18 or older.");
    expect((screen.getByRole<HTMLInputElement>("checkbox")).checked).toBe(false);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    expect((await screen.findByRole("alert")).textContent).toBe("This service is for people aged 18 and over.");
    expect(api.requestOtp).not.toHaveBeenCalled();
    type(/Date of birth/, "1995-05-05");
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    await screen.findByLabelText(/Verification code/);
    expect(api.requestOtp).toHaveBeenCalledWith("+201012345678", "register");
    type(/Verification code/, "123456");
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => { expect(navigate).toHaveBeenCalled(); });
    expect(api.verifyOtp).toHaveBeenCalledWith({ challengeId: "c1", phoneE164: "+201012345678", code: "123456", dob: "1995-05-05" });
  });

  it("a dob-required problem on verify sends the shopper to the registration form", async () => {
    const api = stubApi({ requestOtp: vi.fn().mockResolvedValue(challenge), verifyOtp: vi.fn().mockRejectedValue(new ApiProblem(422, "dob-required", null, null)) });
    render(<LoginForm locale={EN} api={api} navigate={vi.fn()} webauthn={{ supported: () => false, authenticate: vi.fn() }} />);
    type(/Mobile number/, "01012345678");
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    await screen.findByLabelText(/Verification code/);
    type(/Verification code/, "123456");
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect((await screen.findByRole("alert")).textContent).toContain("check your age");
    expect(screen.getByLabelText(/Date of birth/)).toBeTruthy();
  });

  it("new users see consent checkboxes that are never pre-ticked and only ticked purposes are saved", async () => {
    const api = stubApi({
      requestOtp: vi.fn().mockResolvedValue(challenge), verifyOtp: vi.fn().mockResolvedValue({ isNewUser: true }),
      listConsents: vi.fn().mockResolvedValue([consent("marketing_push"), consent("analytics"), consent("personalization")]), patchConsents: vi.fn().mockResolvedValue([]),
    });
    const navigate = vi.fn();
    render(<LoginForm locale={EN} api={api} navigate={navigate} webauthn={{ supported: () => false, authenticate: vi.fn() }} />);
    type(/Mobile number/, "01012345678");
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    await screen.findByLabelText(/Verification code/);
    type(/Verification code/, "123456");
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await screen.findByText("Your privacy choices");
    const boxes = screen.getAllByRole<HTMLInputElement>("checkbox");
    expect(boxes).toHaveLength(3);
    expect(boxes.every((b) => !b.checked)).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Consent analytics"));
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => { expect(navigate).toHaveBeenCalledWith("/eg-en"); });
    expect(api.patchConsents).toHaveBeenCalledWith([{ code: "analytics", version: 3, granted: true }]);
  });

  it("skipping consents saves nothing", async () => {
    const api = stubApi({ requestOtp: vi.fn().mockResolvedValue(challenge), verifyOtp: vi.fn().mockResolvedValue({ isNewUser: true }), listConsents: vi.fn().mockResolvedValue([consent("analytics")]) });
    const navigate = vi.fn();
    render(<LoginForm locale={EN} api={api} navigate={navigate} webauthn={{ supported: () => false, authenticate: vi.fn() }} />);
    type(/Mobile number/, "01012345678");
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    await screen.findByLabelText(/Verification code/);
    type(/Verification code/, "123456");
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    fireEvent.click(await screen.findByRole("button", { name: "Skip" }));
    expect(navigate).toHaveBeenCalledWith("/eg-en");
    expect(api.patchConsents).not.toHaveBeenCalled();
  });

  it("passkey sign-in appears only when supported and runs options, ceremony, verify", async () => {
    const webauthn: WebAuthnPort = { supported: () => true, authenticate: vi.fn().mockResolvedValue({ id: "cred" }) };
    const api = stubApi({ passkeyOptions: vi.fn().mockResolvedValue({ challengeId: "pc", publicKey: { challenge: "x" } }), passkeyVerify: vi.fn().mockResolvedValue({ isNewUser: false }) });
    const navigate = vi.fn();
    render(<LoginForm locale={EN} api={api} navigate={navigate} webauthn={webauthn} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with a passkey" }));
    await waitFor(() => { expect(navigate).toHaveBeenCalledWith("/eg-en"); });
    expect(webauthn.authenticate).toHaveBeenCalledWith({ challenge: "x" });
    expect(api.passkeyVerify).toHaveBeenCalledWith("pc", { id: "cred" });
  });
  it("a cancelled passkey ceremony shows an error and the passkey button is hidden when unsupported", async () => {
    const api = stubApi({ passkeyOptions: vi.fn().mockResolvedValue({ challengeId: "pc", publicKey: {} }) });
    const { unmount } = render(<LoginForm locale={EN} api={api} navigate={vi.fn()} webauthn={{ supported: () => true, authenticate: vi.fn().mockRejectedValue(new Error("NotAllowed")) }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with a passkey" }));
    expect((await screen.findByRole("alert")).textContent).toBe("We could not sign you in with a passkey.");
    unmount();
    render(<LoginForm locale={EN} api={api} navigate={vi.fn()} webauthn={{ supported: () => false, authenticate: vi.fn() }} />);
    expect(screen.queryByRole("button", { name: "Sign in with a passkey" })).toBeNull();
  });

  it.each([["ar-EG"], ["en-EG"]] as const)("has no axe violations (%s)", async (locale) => {
    const api = stubApi({ requestOtp: vi.fn().mockResolvedValue(challenge) });
    const { container } = render(<><h1 id="login-title">x</h1><LoginForm locale={locale} api={api} navigate={vi.fn()} webauthn={{ supported: () => true, authenticate: vi.fn() }} /></>);
    await screen.findAllByRole("button");
    await expectNoA11yViolations(container);
    fireEvent.click(screen.getAllByRole("button")[1]!);
    await expectNoA11yViolations(container);
  });
});

const accountApi = (over = {}) => stubApi({
  me: vi.fn().mockResolvedValue({ phoneMasked: "+201••••••678" }),
  listSessions: vi.fn().mockResolvedValue([session(), session({ id: "s2", current: false, platform: "ios", ua_family: null })]),
  listConsents: vi.fn().mockResolvedValue([consent("analytics"), consent("marketing_push", true)]),
  listPrivacyRequests: vi.fn().mockResolvedValue([]), ...over,
});

describe("AccountPanel", () => {
  it("lists sessions (revoke only for other devices) and revokes one", async () => {
    const api = accountApi({ revokeSession: vi.fn().mockResolvedValue(undefined) });
    render(<AccountPanel locale={EN} api={api} navigate={vi.fn()} />);
    await screen.findByText("Signed-in devices");
    expect(screen.getAllByRole("button", { name: /End session/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /End session \(ios\)/ }));
    await waitFor(() => { expect(api.revokeSession).toHaveBeenCalledWith("s2"); });
    await waitFor(() => { expect(screen.queryByRole("button", { name: /End session/ })).toBeNull(); });
  });
  it("consent toggles reflect the server state and patch with the purpose version", async () => {
    const api = accountApi({ patchConsents: vi.fn().mockResolvedValue([consent("analytics", true)]) });
    render(<AccountPanel locale={EN} api={api} navigate={vi.fn()} />);
    const analytics = await screen.findByLabelText<HTMLInputElement>("Consent analytics");
    expect(analytics.checked).toBe(false);
    expect((screen.getByLabelText<HTMLInputElement>("Consent marketing_push")).checked).toBe(true);
    fireEvent.click(analytics);
    await waitFor(() => { expect((screen.getByLabelText<HTMLInputElement>("Consent analytics")).checked).toBe(true); });
    expect(api.patchConsents).toHaveBeenCalledWith([{ code: "analytics", version: 3, granted: true }]);
    expect(screen.getByText("Your choice was saved.")).toBeTruthy();
  });
  it("requests an export, and deletion needs both acknowledgements and explains the 14-day cooling", async () => {
    const api = accountApi({ requestExport: vi.fn().mockResolvedValue(privacyRequest({ kind: "export", status: "RECEIVED", cooling_until: null })), requestDelete: vi.fn().mockResolvedValue(privacyRequest()) });
    render(<AccountPanel locale={EN} api={api} navigate={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Request a copy of my data" }));
    await screen.findByText("We received your request. It will be ready within 72 hours.");
    expect(screen.getByText(/14-day cooling period/)).toBeTruthy();
    const del = screen.getByRole<HTMLButtonElement>("button", { name: "Request account deletion" });
    expect(del.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Outlex credit is forfeited/));
    expect(del.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I confirm I want to delete/));
    expect(del.disabled).toBe(false);
    fireEvent.click(del);
    await screen.findByText(/Deletion is cooling until/);
    expect(api.requestDelete).toHaveBeenCalledWith(true);
  });
  it("shows an existing cooling request, can cancel it, and shows why a deletion is blocked", async () => {
    const api = accountApi({ listPrivacyRequests: vi.fn().mockResolvedValue([privacyRequest({ status: "BLOCKED", blocked_reason: "open order" })]), cancelDelete: vi.fn().mockResolvedValue(undefined) });
    render(<AccountPanel locale={EN} api={api} navigate={vi.fn()} />);
    await screen.findByText("Deletion is blocked: open order");
    fireEvent.click(screen.getByRole("button", { name: "Cancel deletion request" }));
    await waitFor(() => { expect(api.cancelDelete).toHaveBeenCalled(); });
    await screen.findByRole("button", { name: "Request account deletion" });
  });
  it("offers a ready export link", async () => {
    render(<AccountPanel locale={EN} api={accountApi({ listPrivacyRequests: vi.fn().mockResolvedValue([privacyRequest({ kind: "export", status: "COMPLETED", export_url: "https://files.example/x.zip", cooling_until: null })]) })} navigate={vi.fn()} />);
    expect((await screen.findByRole("link", { name: "Download copy" })).getAttribute("href")).toBe("https://files.example/x.zip");
  });
  it("switches language by navigating to the other segment and signs out", async () => {
    const api = accountApi({ logout: vi.fn().mockResolvedValue(undefined) });
    const navigate = vi.fn();
    render(<AccountPanel locale={EN} api={api} navigate={navigate} />);
    fireEvent.click(await screen.findByRole("button", { name: "العربية" }));
    expect(navigate).toHaveBeenCalledWith("/eg-ar/account");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => { expect(navigate).toHaveBeenCalledWith("/eg-en/login"); });
  });
  it("signed-out and failed loads render honest states", async () => {
    const { unmount } = render(<AccountPanel locale={EN} api={accountApi({ me: vi.fn().mockRejectedValue(new ApiProblem(401, "unauthenticated", null, null)) })} />);
    expect((await screen.findByRole("link", { name: "Sign in" })).getAttribute("href")).toBe("/eg-en/login?next=%2Feg-en%2Faccount");
    unmount();
    render(<AccountPanel locale={EN} api={accountApi({ me: vi.fn().mockRejectedValue(new Error("boom")) })} />);
    expect((await screen.findByRole("alert")).textContent).toBe("We could not load your account.");
  });
  it.each([["ar-EG"], ["en-EG"]] as const)("has no axe violations (%s)", async (locale) => {
    const { container } = render(<AccountPanel locale={locale} api={accountApi({ listPrivacyRequests: vi.fn().mockResolvedValue([privacyRequest()]) })} />);
    await waitFor(() => { expect(container.querySelector("h2")).not.toBeNull(); });
    await expectNoA11yViolations(container);
  });
});
