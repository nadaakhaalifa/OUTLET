import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator, type Locale } from "@outlet/i18n";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { AuditView } from "../src/components/AuditView";
import { BreachStubForm } from "../src/components/BreachStubForm";
import { DpoView, dueText } from "../src/components/DpoView";
import { ElevationPanel } from "../src/components/ElevationPanel";
import { KycCasePanel } from "../src/components/KycCasePanel";
import { KycQueue } from "../src/components/KycQueue";
import { PasskeyLogin } from "../src/components/PasskeyLogin";
import { PriceView } from "../src/components/PriceView";
import { ProblemBanner } from "../src/components/ProblemBanner";
import { ReconView, isEscalated } from "../src/components/ReconView";
import { BreakGlassBanner, RoleBadge, Sidebar } from "../src/components/Shell";
import { ReasonDialog } from "../src/components/ReasonDialog";
import { profileFromSession } from "../src/server/session";
import { CASE_ID, DOC_ID, kycCase, reconItem } from "./fake-data";

const LOCALES: readonly Locale[] = ["ar-EG", "en-EG"];
const clean = async (): Promise<string[]> => {
  const r = await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
  return r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html ?? ""}`);
};
const profile = profileFromSession({ staff_id: CASE_ID, market_id: "eg", roles: ["ops", "super_admin"], amr: ["hwk"], expires_at: "2099-01-01T00:00:00Z" });
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe.each(LOCALES)("shell (%s)", (locale) => {
  const t = createTranslator(locale);
  it("renders the sidebar, role badges and break-glass banner without axe violations", async () => {
    render(<><Sidebar t={t} base="/eg-ar" sections={["kyc", "access"]} current="kyc" /><RoleBadge t={t} profile={profile} /><BreakGlassBanner t={t} /><ProblemBanner t={t} code="forbidden" status={403} /></>);
    expect(screen.getByRole("link", { name: t("admin.nav.kyc") }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("link", { name: t("admin.nav.recon") })).toBeNull();
    expect(screen.getByTestId("break-glass").textContent).toContain(t("admin.breakGlass.title"));
    expect(screen.getByText(t("admin.role.super_admin"))).toBeTruthy();
    expect(await clean()).toEqual([]);
  });
});

describe.each(LOCALES)("KYC (%s)", (locale) => {
  const t = createTranslator(locale);
  it("lists cases, shows an honest empty state", async () => {
    const { rerender } = render(<KycQueue t={t} locale={locale} base="/eg-ar" status="" items={[{ id: CASE_ID, seller_id: CASE_ID, legal_name_ar: "متجر النيل", status: "SUBMITTED", submitted_at: null }]} />);
    expect(screen.getByRole("link", { name: new RegExp(t("admin.kyc.open")) }).getAttribute("href")).toBe(`/eg-ar/kyc/${CASE_ID}`);
    expect(screen.getByText(t("admin.kyc.notSubmitted"))).toBeTruthy();
    expect(await clean()).toEqual([]);
    rerender(<KycQueue t={t} locale={locale} base="/eg-ar" status="" items={[]} />);
    expect(screen.getByText(t("admin.kyc.empty"))).toBeTruthy();
  });

  it("needs a reason code before a document link is requested, then sends it as X-Reason-Code", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { url: "https://files.example.test/doc.pdf" }));
    render(<KycCasePanel locale={locale} market="eg" data={kycCase} canDecide />);
    fireEvent.click(screen.getByRole("button", { name: t("admin.kyc.doc.open") }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t("admin.action.confirm") }));
    expect(screen.getByRole("alert").textContent).toBe(t("admin.reason.choose"));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(t("admin.reason.code")), { target: { value: "support_ticket" } });
    fireEvent.change(screen.getByLabelText(t("admin.reason.ticket")), { target: { value: "T-42" } });
    fireEvent.click(screen.getByRole("button", { name: t("admin.action.confirm") }));
    await waitFor(() => { expect(screen.getByRole("link", { name: t("admin.kyc.doc.openLink") }).getAttribute("href")).toBe("https://files.example.test/doc.pdf"); });
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe(`/api/admin/eg/kyc-cases/${CASE_ID}/documents/${DOC_ID}/url`);
    expect(init.headers["x-reason-code"]).toBe("support_ticket:T-42");
    expect(await clean()).toEqual([]);
  });

  it("requires a reference for other_with_note and shows the API refusal", async () => {
    fetchMock.mockResolvedValueOnce(json(400, { code: "reason-code-required" }));
    render(<KycCasePanel locale={locale} market="eg" data={kycCase} canDecide />);
    fireEvent.click(screen.getByRole("button", { name: t("admin.kyc.doc.open") }));
    fireEvent.change(screen.getByLabelText(t("admin.reason.code")), { target: { value: "other_with_note" } });
    fireEvent.click(screen.getByRole("button", { name: t("admin.action.confirm") }));
    expect(screen.getByRole("alert").textContent).toBe(t("admin.reason.refRequired"));
    fireEvent.change(screen.getByLabelText(t("admin.reason.ticket")), { target: { value: "X1" } });
    fireEvent.click(screen.getByRole("button", { name: t("admin.action.confirm") }));
    await waitFor(() => { expect(screen.getByText(t("admin.error.reasonRequired"))).toBeTruthy(); });
  });

  it("reveals the signatory with a reason code", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ...kycCase, signatory_revealed: { full_name: "منى", national_id: "29801011234821", phone_e164: "+201000000000" } }));
    render(<KycCasePanel locale={locale} market="eg" data={kycCase} canDecide />);
    fireEvent.click(screen.getByRole("button", { name: t("admin.kyc.signatory.reveal") }));
    fireEvent.change(screen.getByLabelText(t("admin.reason.code")), { target: { value: "fraud_review" } });
    fireEvent.click(screen.getByRole("button", { name: t("admin.action.confirm") }));
    await waitFor(() => { expect(screen.getByText("29801011234821")).toBeTruthy(); });
  });

  it("posts the decision with a reason code and note, and reports a second-approver wait", async () => {
    fetchMock.mockResolvedValueOnce(json(202, { approval_request_id: CASE_ID }));
    render(<KycCasePanel locale={locale} market="eg" data={kycCase} canDecide />);
    fireEvent.click(screen.getByLabelText(t("admin.kyc.decision.NEEDS_INFO")));
    fireEvent.click(screen.getByLabelText(t("admin.kyc.doc.tax_card")));
    fireEvent.change(screen.getByLabelText(t("admin.kyc.decision.note")), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: t("admin.kyc.decision.submit") }));
    await waitFor(() => { expect(screen.getByRole("status").textContent).toBe(t("admin.kyc.decision.pendingApproval")); });
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string; headers: Record<string, string> }];
    expect(JSON.parse(init.body)).toEqual({ decision: "NEEDS_INFO", decision_reason: "docs_valid: x", requested_documents: ["tax_card"] });
    expect(init.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(refresh).toHaveBeenCalled();
  });

  it("hides the decision form for view-only roles and closed cases, and surfaces failures", async () => {
    const { rerender } = render(<KycCasePanel locale={locale} market="eg" data={kycCase} canDecide={false} />);
    expect(screen.getByText(t("admin.kyc.decision.noRole"))).toBeTruthy();
    rerender(<KycCasePanel locale={locale} market="eg" data={{ ...kycCase, case: { ...kycCase.case, status: "APPROVED" } }} canDecide />);
    expect(screen.getByText(t("admin.kyc.decision.closed"))).toBeTruthy();
    rerender(<KycCasePanel locale={locale} market="eg" data={kycCase} canDecide />);
    fetchMock.mockResolvedValueOnce(json(403, { code: "forbidden" }));
    fireEvent.click(screen.getByRole("button", { name: t("admin.kyc.decision.submit") }));
    await waitFor(() => { expect(screen.getByRole("alert").textContent).toBe(t("admin.error.forbidden")); });
  });

  it("closes the reason dialog on cancel without any request", () => {
    const onCancel = vi.fn();
    render(<ReasonDialog t={t} open onConfirm={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: t("admin.action.cancel") }));
    expect(onCancel).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe.each(LOCALES)("price integrity (%s)", (locale) => {
  const t = createTranslator(locale);
  it("shows honest empty states and no action buttons", async () => {
    render(<PriceView t={t} locale={locale} actions={[]} trust={[]} findings={[]} />);
    for (const k of ["admin.price.actions.empty", "admin.price.trust.empty", "admin.price.appeals.empty", "admin.price.findings.empty"] as const) expect(screen.getByText(t(k))).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(await clean()).toEqual([]);
  });
  it("lists actions, trust scores and appeals", async () => {
    const store = "5702e000-0000-4000-8000-000000000001";
    render(<PriceView t={t} locale={locale} actions={[{ id: DOC_ID, store_id: store, action: "badge_removed", starts_at: "2026-11-01T00:00:00Z", expires_at: null, status: "ACTIVE", human_review_required: true }]}
      trust={[{ store_id: store, score: 62, violations_90d: 2, computed_at: "2026-11-02T00:00:00Z" }]}
      findings={[{ store_id: store, finding: { id: CASE_ID, rule: "ghost_discount", severity: "severe", status: "APPEALED", detected_at: "2026-11-02T00:00:00Z" } }]} />);
    expect(screen.getByText(t("admin.price.action.badge_removed"))).toBeTruthy();
    expect(screen.getByText(t("admin.price.review.needed"))).toBeTruthy();
    expect(screen.getAllByText(t("admin.price.rule.ghost_discount"))).toHaveLength(2);
    expect(await clean()).toEqual([]);
  });
});

describe.each(LOCALES)("reconciliation (%s)", (locale) => {
  const t = createTranslator(locale);
  const run = { id: "7e100000-0000-4000-8000-000000000001", source: "psp_settlement", counterparty: "paymob", business_date: "2026-11-07", mode: "nightly", status: "COMPLETED", matched_count: 10, unmatched_count: 2, started_at: "2026-11-08T00:00:00Z" };
  it("escalates items older than three days and keeps integrity checks as 'not run yet'", async () => {
    expect(isEscalated(reconItem({ age_days: 4 }))).toBe(true);
    expect(isEscalated(reconItem({ age_days: 3 }))).toBe(false);
    expect(isEscalated(reconItem({ age_days: 9, status: "RESOLVED" }))).toBe(false);
    const { container } = render(<ReconView t={t} locale={locale} market="eg" base="/eg-ar" today="2026-11-08" runs={[run]} selectedRun={run.id} canRun
      items={[reconItem({ age_days: 5, status: "AMOUNT_MISMATCH" }), reconItem({ id: "a1000000-0000-4000-8000-000000000002", age_days: 1, actual: { amount_minor: "99000", currency: "EGP" } })]} />);
    const rows = container.querySelectorAll("tr[data-aging]");
    expect(rows[0]?.getAttribute("data-aging")).toBe("escalated");
    expect(rows[1]?.getAttribute("data-aging")).toBe("ok");
    expect(screen.getByText(t("admin.recon.age.escalated"))).toBeTruthy();
    expect(screen.getByTestId("trial-balance").textContent).toBe(t("admin.recon.integrity.notRun"));
    expect(screen.getByTestId("hash-chain").textContent).toBe(t("admin.recon.integrity.notRun"));
    expect(await clean()).toEqual([]);
  });
  it("shows empty states and posts a resolution", async () => {
    const { rerender } = render(<ReconView t={t} locale={locale} market="eg" base="/eg-ar" today="2026-11-08" runs={[]} selectedRun={null} items={null} canRun={false} />);
    expect(screen.getByText(t("admin.recon.runs.empty"))).toBeTruthy();
    expect(screen.getByText(t("admin.recon.items.pickRun"))).toBeTruthy();
    rerender(<ReconView t={t} locale={locale} market="eg" base="/eg-ar" today="2026-11-08" runs={[run]} selectedRun={run.id} items={[]} canRun />);
    expect(screen.getByText(t("admin.recon.items.empty"))).toBeTruthy();
    rerender(<ReconView t={t} locale={locale} market="eg" base="/eg-ar" today="2026-11-08" runs={[run]} selectedRun={run.id} items={[reconItem({ age_days: 5 }), reconItem({ id: "a1000000-0000-4000-8000-000000000003", status: "RESOLVED" })]} canRun />);
    fetchMock.mockResolvedValueOnce(json(200, { item: {}, approval_request_id: null }));
    fireEvent.change(screen.getByLabelText(t("admin.recon.resolve.ticket")), { target: { value: "FIN-7" } });
    fireEvent.change(screen.getByLabelText(t("admin.recon.resolve.note")), { target: { value: "ok" } });
    fireEvent.click(screen.getByRole("button", { name: t("admin.recon.resolve.submit"), hidden: true }));
    await waitFor(() => { expect(screen.getByText(t("admin.recon.resolve.done"))).toBeTruthy(); });
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body)).toEqual({ resolution: "matched_manually", ticket_ref: "FIN-7", note: "ok" });
  });
  it("starts a manual run and reports a failure", async () => {
    render(<ReconView t={t} locale={locale} market="eg" base="/eg-ar" today="2026-11-08" runs={[]} selectedRun={null} items={null} canRun />);
    fetchMock.mockResolvedValueOnce(json(403, { code: "forbidden" }));
    fireEvent.change(screen.getByLabelText(t("admin.recon.start.counterparty")), { target: { value: "paymob" } });
    fireEvent.click(screen.getByRole("button", { name: t("admin.recon.start.submit") }));
    await waitFor(() => { expect(screen.getByRole("alert").textContent).toBe(t("admin.error.forbidden")); });
  });
});

describe.each(LOCALES)("DPO (%s)", (locale) => {
  const t = createTranslator(locale);
  const now = new Date("2026-11-08T10:00:00Z");
  it("computes due timers and flags overdue requests", () => {
    expect(dueText(t, { due_at: "2026-11-10T02:00:00Z", completed_at: null }, now, locale).overdue).toBe(false);
    expect(dueText(t, { due_at: "2026-11-08T05:00:00Z", completed_at: null }, now, locale).overdue).toBe(true);
    expect(dueText(t, { due_at: "2026-11-01T05:00:00Z", completed_at: "2026-11-02T00:00:00Z" }, now, locale).text).toBe(t("admin.dpo.due.done"));
  });
  it("renders the queue, aggregate consent counts, the breach register and the non-submitting stub", async () => {
    const { container } = render(<DpoView t={t} locale={locale} now={now}
      requests={[{ id: CASE_ID, subject_ref: "usr_1", kind: "export", status: "PENDING", due_at: "2026-11-10T02:00:00Z", created_at: "2026-11-07T00:00:00Z" }, { id: DOC_ID, subject_ref: "usr_2", kind: "delete", status: "PENDING", due_at: "2026-11-08T05:00:00Z", created_at: "2026-10-01T00:00:00Z" }]}
      consent={{ as_of: "2026-11-08T00:00:00Z", purposes: [{ purpose_code: "marketing_push", purpose_version: 1, granted_count: 412, withdrawn_30d: 9 }] }}
      breaches={[{ id: CASE_ID, detected_at: "2026-11-07T00:00:00Z", severity: "high", summary: "s", status: "DETECTED" }]} transfers={[]} />);
    expect(container.querySelectorAll('tr[data-overdue="true"]')).toHaveLength(1);
    expect(screen.getByText(t("admin.dpo.transfers.empty"))).toBeTruthy();
    const submit = screen.getByRole("button", { name: t("admin.dpo.breach.form.submit") });
    expect(submit.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(submit);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getAllByText(t("admin.dpo.breach.form.stub")).length).toBeGreaterThan(0);
    expect(await clean()).toEqual([]);
  });
  it("shows empty states", () => {
    render(<DpoView t={t} locale={locale} now={now} requests={[]} consent={null} breaches={[]} transfers={[]} />);
    for (const k of ["admin.dpo.requests.empty", "admin.dpo.consent.empty", "admin.dpo.breach.empty"] as const) expect(screen.getByText(t(k))).toBeTruthy();
  });
  it("renders the stub form on its own accessibly", async () => {
    render(<BreachStubForm locale={locale} />);
    expect(await clean()).toEqual([]);
  });
});

describe.each(LOCALES)("audit (%s)", (locale) => {
  const t = createTranslator(locale);
  const filters = { actor_id: "", action: "", target_type: "", from: "", to: "" };
  it("lists entries, and the verify button reports a missing route honestly", async () => {
    render(<AuditView t={t} locale={locale} market="eg" filters={filters} entries={[{ id: CASE_ID, actor_type: "staff", actor_id: DOC_ID, action: "kyc.document.open", target_type: "kyc_document", target_id: CASE_ID, reason_code: "dsar", request_id: "r1", occurred_at: "2026-11-08T10:00:00Z" }]} />);
    expect(screen.getByText("kyc.document.open")).toBeTruthy();
    expect(screen.getByTestId("chain-status").textContent).toBe(t("admin.audit.verify.notRun"));
    fetchMock.mockResolvedValueOnce(json(404, { code: "not-found" }));
    fireEvent.click(screen.getByRole("button", { name: t("admin.audit.verify.run") }));
    await waitFor(() => { expect(screen.getByTestId("chain-status").textContent).toBe(t("admin.audit.verify.unavailable")); });
    expect(await clean()).toEqual([]);
  });
  it.each([[{ valid: true }, "admin.audit.verify.ok"], [{ valid: false }, "admin.audit.verify.broken"], [{}, "admin.error.generic"]] as const)("maps %j", async (body, key) => {
    render(<AuditView t={t} locale={locale} market="eg" filters={filters} entries={[]} />);
    expect(screen.getByText(t("admin.audit.empty"))).toBeTruthy();
    fetchMock.mockResolvedValueOnce(json(200, body));
    fireEvent.click(screen.getByRole("button", { name: t("admin.audit.verify.run") }));
    await waitFor(() => { expect(screen.getByTestId("chain-status").textContent).toBe(t(key)); });
  });
  it("maps a server error", async () => {
    render(<AuditView t={t} locale={locale} market="eg" filters={filters} entries={[]} />);
    fetchMock.mockResolvedValueOnce(json(500, { code: "x" }));
    fireEvent.click(screen.getByRole("button", { name: t("admin.audit.verify.run") }));
    await waitFor(() => { expect(screen.getByTestId("chain-status").textContent).toBe(t("admin.error.generic")); });
  });
});

describe.each(LOCALES)("elevation (%s)", (locale) => {
  const t = createTranslator(locale);
  const req = { id: CASE_ID, action: "role.elevate", target_type: "staff", target_id: DOC_ID, requested_by: DOC_ID, status: "PENDING", created_at: "2026-11-08T10:00:00Z", expires_at: "2026-11-08T10:30:00Z" };
  it("reports a missing elevation route instead of pretending it was sent", async () => {
    render(<ElevationPanel locale={locale} market="eg" requests={[]} canDecide={false} selfId={CASE_ID} />);
    expect(screen.getByText(t("admin.access.pending.none"))).toBeTruthy();
    fetchMock.mockResolvedValueOnce(json(404, { code: "not-found" }));
    fireEvent.change(screen.getByLabelText(t("admin.access.request.reason")), { target: { value: "incident" } });
    fireEvent.click(screen.getByRole("button", { name: t("admin.access.request.submit") }));
    await waitFor(() => { expect(screen.getByRole("alert").textContent).toBe(t("admin.access.request.unavailable")); });
    expect(await clean()).toEqual([]);
  });
  it("sends a request, and lets a different staff member approve with a reason (never the requester)", async () => {
    const { rerender } = render(<ElevationPanel locale={locale} market="eg" requests={[req]} canDecide selfId={DOC_ID} />);
    expect(screen.queryByRole("button", { name: t("admin.access.approve") })).toBeNull();
    fetchMock.mockResolvedValueOnce(json(201, {}));
    fireEvent.change(screen.getByLabelText(t("admin.access.request.reason")), { target: { value: "incident" } });
    fireEvent.click(screen.getByRole("button", { name: t("admin.access.request.submit") }));
    await waitFor(() => { expect(screen.getByRole("status").textContent).toBe(t("admin.access.request.sent")); });
    rerender(<ElevationPanel locale={locale} market="eg" requests={[req]} canDecide selfId={CASE_ID} />);
    const approve = screen.getByRole("button", { name: t("admin.access.approve") });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(t("admin.access.decision.reason")), { target: { value: "verified" } });
    fetchMock.mockResolvedValueOnce(json(200, {}));
    fireEvent.click(screen.getByRole("button", { name: t("admin.access.approve") }));
    await waitFor(() => { expect(screen.getAllByRole("status").length).toBeGreaterThan(0); });
    expect(await clean()).toEqual([]);
  });
  it("shows API failures on rows and on the request form", async () => {
    render(<ElevationPanel locale={locale} market="eg" requests={[req]} canDecide selfId={CASE_ID} />);
    fireEvent.change(screen.getByLabelText(t("admin.access.decision.reason")), { target: { value: "no" } });
    fetchMock.mockResolvedValueOnce(json(403, { code: "forbidden" }));
    fireEvent.click(screen.getByRole("button", { name: t("admin.access.reject") }));
    await waitFor(() => { expect(screen.getByText(t("admin.error.forbidden"))).toBeTruthy(); });
    fetchMock.mockResolvedValueOnce(json(429, { code: "rate-limited" }));
    fireEvent.change(screen.getByLabelText(t("admin.access.request.reason")), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: t("admin.access.request.submit") }));
    await waitFor(() => { expect(screen.getAllByRole("alert").some((a) => a.textContent === t("admin.error.rate"))).toBe(true); });
  });
});

describe.each(LOCALES)("passkey login (%s)", (locale) => {
  const t = createTranslator(locale);
  const stubCredentials = (get: () => Promise<unknown>) => {
    vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() { return null; });
    Object.defineProperty(navigator, "credentials", { value: { get }, configurable: true });
  };
  const buf = new Uint8Array([1, 2, 3]).buffer;
  const cred = { id: "c", rawId: buf, type: "public-key", response: { clientDataJSON: buf, authenticatorData: buf, signature: buf, userHandle: null } };

  it("keeps the TOTP fallback disabled and explains it", async () => {
    render(<PasskeyLogin locale={locale} market="eg" home="/eg-ar" />);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: t("admin.login.totp") }).disabled).toBe(true);
    expect(screen.getByText(t("admin.login.totpSoon"))).toBeTruthy();
    expect(await clean()).toEqual([]);
  });
  it("says so when passkeys are unsupported", () => {
    vi.stubGlobal("PublicKeyCredential", undefined);
    render(<PasskeyLogin locale={locale} market="eg" home="/eg-ar" />);
    fireEvent.click(screen.getByRole("button", { name: t("admin.login.passkey") }));
    expect(screen.getByRole("alert").textContent).toBe(t("admin.login.error.unsupported"));
  });
  it("runs options, the authenticator and verify, then navigates home", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { assign });
    stubCredentials(() => Promise.resolve(cred));
    fetchMock.mockResolvedValueOnce(json(200, { challenge_id: CASE_ID, public_key: { challenge: "AQID" }, expires_at: "2099-01-01T00:00:00Z" })).mockResolvedValueOnce(json(200, {}));
    render(<PasskeyLogin locale={locale} market="eg" home="/eg-ar" />);
    fireEvent.click(screen.getByRole("button", { name: t("admin.login.passkey") }));
    await waitFor(() => { expect(assign).toHaveBeenCalledWith("/eg-ar"); });
    expect(fetchMock.mock.calls.map((c) => String((c as unknown[])[0]))).toEqual(["/api/admin/eg/auth/passkey/options", "/api/admin/eg/auth/passkey/verify"]);
  });
  it("reports a cancelled prompt, a failed verify and a failed options call", async () => {
    stubCredentials(() => Promise.reject(new Error("NotAllowed")));
    fetchMock.mockImplementation(() => Promise.resolve(json(200, { challenge_id: CASE_ID, public_key: { challenge: "AQID" }, expires_at: "2099-01-01T00:00:00Z" })));
    render(<PasskeyLogin locale={locale} market="eg" home="/eg-ar" />);
    fireEvent.click(screen.getByRole("button", { name: t("admin.login.passkey") }));
    await waitFor(() => { expect(screen.getByRole("alert").textContent).toBe(t("admin.login.error.cancelled")); });
    stubCredentials(() => Promise.resolve(null));
    fireEvent.click(screen.getByRole("button", { name: t("admin.login.passkey") }));
    await waitFor(() => { expect(screen.getByRole("alert").textContent).toBe(t("admin.login.error.cancelled")); });
    stubCredentials(() => Promise.resolve(cred));
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(json(200, { challenge_id: CASE_ID, public_key: { challenge: "AQID" } })).mockResolvedValueOnce(json(401, { code: "unauthenticated" }));
    fireEvent.click(screen.getByRole("button", { name: t("admin.login.passkey") }));
    await waitFor(() => { expect(screen.getByRole("alert").textContent).toBe(t("admin.login.error.failed")); });
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(json(503, { code: "api-unavailable" }));
    fireEvent.click(screen.getByRole("button", { name: t("admin.login.passkey") }));
    await waitFor(() => { expect(screen.getByRole("alert").textContent).toBe(t("admin.error.apiDown")); });
  });
});
