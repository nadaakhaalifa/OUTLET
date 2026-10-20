import { describe, expect, it } from "vitest";
import { fakeApi, problem } from "../../services/fake-api";
import { clockFromServer } from "../drops/serverClock";
import type { Membership } from "../plus/model";
import { PortError } from "../worlds/model";
import { ApiAutoBuyPort, createOutcomeFromError, ruleFromWire } from "./api";
import {
  CANCEL_WINDOW_MINUTES, FIXTURE_CAPABILITIES, FIXTURE_TERMS, InMemoryAutoBuyPort, MAX_RULE_DAYS, buildRuleRows, cancelWindow, isPlusMember, ruleSheetAccess,
  validateDraft, validateNotify, type AutoBuyAttempt, type AutoBuyCapabilities, type AutoBuyDraft, type AutoBuyRule, type DraftInput,
} from "./model";

const SKU = "0192f3a4-5b6c-7d8e-9f01-23456789abc1";
const RULE = "0192f3a4-5b6c-7d8e-9f01-23456789abc2";
const ATT = "0192f3a4-5b6c-7d8e-9f01-23456789abc3";
const ORDER = "0192f3a4-5b6c-7d8e-9f01-23456789abc4";
const NOW = Date.parse("2026-10-11T10:00:00Z");

const input = (over: Partial<DraftInput> = {}): DraftInput => ({
  targetText: "649", maxText: "700", currentPrice: 90_000n, expiryDays: 30, consent: true, terms: FIXTURE_TERMS.en, skuId: SKU, sizeLabel: "M",
  mode: "notifyConfirm", savedCard: null, nowMs: NOW, locale: "en", ...over,
});

const attempt = (over: Partial<AutoBuyAttempt> = {}): AutoBuyAttempt => ({
  id: ATT, state: "NOTIFIED", mode: "unattended", noticeSentAtMs: NOW, cancelDeadlineMs: NOW + CANCEL_WINDOW_MINUTES * 60_000, cancellable: true, failureReason: null, orderGroupId: null, ...over,
});

const rule = (over: Partial<AutoBuyRule> = {}): AutoBuyRule => ({
  id: RULE, skuId: SKU, productId: null, title: null, sizeLabel: "M", targetPrice: 64_900n, maxPrice: 70_000n, mode: "notifyConfirm", status: "ARMED", closedReason: null,
  paused: false, expiresAtMs: NOW + 30 * 86_400_000, acceptedAtMs: NOW, termsVersion: 3, latestAttempt: null, ...over,
});

describe("entitlement and access", () => {
  const m = (status: Membership["status"]): Membership => ({ status, planId: "p", periodEnd: 0, trialEnd: null, pausedUntil: null, graceEndsAt: null });
  it("Plus benefits apply while active, trialing or in grace", () => {
    expect(isPlusMember(m("ACTIVE"))).toBe(true);
    expect(isPlusMember(m("TRIALING"))).toBe(true);
    expect(isPlusMember(m("PAST_DUE"))).toBe(true);
    expect(isPlusMember(m("PAUSED"))).toBe(false);
    expect(isPlusMember(m("EXPIRED"))).toBe(false);
    expect(isPlusMember(null)).toBe(false);
  });

  it("the rule sheet is for Plus members only, and notify-only otherwise", () => {
    expect(ruleSheetAccess(false, FIXTURE_CAPABILITIES)).toEqual({ kind: "notifyOnly", why: "notPlus" });
    expect(ruleSheetAccess(null, FIXTURE_CAPABILITIES)).toEqual({ kind: "notifyOnly", why: "unknown" });
    expect(ruleSheetAccess(true, null)).toEqual({ kind: "notifyOnly", why: "unknown" });
    expect(ruleSheetAccess(true, { ...FIXTURE_CAPABILITIES, enabled: false })).toEqual({ kind: "notifyOnly", why: "disabled" });
  });

  it("a session known not to be passkey-assured gets the step-up prompt; unknown lets the server decide", () => {
    expect(ruleSheetAccess(true, { ...FIXTURE_CAPABILITIES, passkeySession: false })).toEqual({ kind: "stepUp" });
    expect(ruleSheetAccess(true, { ...FIXTURE_CAPABILITIES, passkeySession: null })).toEqual({ kind: "full", offerUnattended: false });
  });

  it("unattended mode is offered only when the server says it is available AND a saved card exists", () => {
    const card = { tokenRef: "tok_12345678", label: "Visa 4242" };
    const caps = (c: Partial<AutoBuyCapabilities>): AutoBuyCapabilities => ({ ...FIXTURE_CAPABILITIES, ...c });
    expect(ruleSheetAccess(true, caps({ unattendedAvailable: false, savedCard: card }))).toEqual({ kind: "full", offerUnattended: false });
    expect(ruleSheetAccess(true, caps({ unattendedAvailable: true, savedCard: null }))).toEqual({ kind: "full", offerUnattended: false });
    expect(ruleSheetAccess(true, caps({ unattendedAvailable: true, savedCard: card }))).toEqual({ kind: "full", offerUnattended: true });
  });
});

describe("draft validation", () => {
  it("builds a draft in piastres with the mandate version the shopper saw", () => {
    const r = validateDraft(input());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft).toMatchObject({ targetPrice: 64_900n, maxPrice: 70_000n, termsVersion: 3, mode: "notifyConfirm", paymentTokenRef: null, sizeLabel: "M" });
    expect(r.draft.expiresAtMs).toBe(NOW + 30 * 86_400_000);
  });

  it("consent must be given: the unticked default blocks arming", () => {
    const r = validateDraft(input({ consent: false }));
    expect(r).toEqual({ ok: false, errors: ["consentMissing"] });
  });

  it("requires the mandate text, a size, a target below the current price and a sane maximum", () => {
    expect(validateDraft(input({ terms: null }))).toMatchObject({ ok: false, errors: expect.arrayContaining(["termsMissing"]) });
    expect(validateDraft(input({ skuId: null }))).toMatchObject({ ok: false, errors: expect.arrayContaining(["sizeMissing"]) });
    expect(validateDraft(input({ targetText: "900", maxText: "950" }))).toMatchObject({ ok: false, errors: ["targetNotBelowPrice"] });
    expect(validateDraft(input({ targetText: "abc" }))).toMatchObject({ ok: false, errors: ["targetInvalid"] });
    expect(validateDraft(input({ maxText: "600" }))).toMatchObject({ ok: false, errors: ["maxBelowTarget"] });
  });

  it("a rule lasts at most 90 days", () => {
    expect(validateDraft(input({ expiryDays: MAX_RULE_DAYS })).ok).toBe(true);
    expect(validateDraft(input({ expiryDays: MAX_RULE_DAYS + 1 }))).toMatchObject({ ok: false, errors: ["expiryInvalid"] });
    expect(validateDraft(input({ expiryDays: 0 }))).toMatchObject({ ok: false, errors: ["expiryInvalid"] });
  });

  it("unattended mode needs a saved card and carries its token; notify mode never does", () => {
    const card = { tokenRef: "tok_12345678", label: "Visa 4242" };
    expect(validateDraft(input({ mode: "unattended" }))).toMatchObject({ ok: false, errors: ["cardMissing"] });
    const r = validateDraft(input({ mode: "unattended", savedCard: card }));
    expect(r.ok && r.draft.paymentTokenRef).toBe("tok_12345678");
    const n = validateDraft(input({ mode: "notifyConfirm", savedCard: card }));
    expect(n.ok && n.draft.paymentTokenRef).toBeNull();
  });

  it("notify-only validation needs a size and a target below the current price", () => {
    expect(validateNotify("500", 90_000n, SKU)).toEqual({ ok: true, target: 50_000n });
    expect(validateNotify("500", 90_000n, null)).toEqual({ ok: false, error: "sizeMissing" });
    expect(validateNotify("1000", 90_000n, SKU)).toEqual({ ok: false, error: "targetNotBelowPrice" });
  });
});

describe("cancel window on server time", () => {
  const deadline = NOW + 15 * 60_000;
  it("uses the server clock offset, not the device clock", () => {
    // The device clock is 10 minutes behind the server: the server says it is NOW, the device says NOW - 10 min.
    const clock = clockFromServer(NOW, NOW - 10 * 60_000);
    const w = cancelWindow(attempt({ cancelDeadlineMs: deadline }), clock, NOW - 10 * 60_000);
    expect(w).toMatchObject({ kind: "open", remainingMs: 15 * 60_000 });
    // Later, 5 device-minutes on, 10 server-minutes remain.
    const later = cancelWindow(attempt({ cancelDeadlineMs: deadline }), clock, NOW - 5 * 60_000);
    expect(later).toMatchObject({ kind: "open", remainingMs: 10 * 60_000 });
    if (later.kind === "open") expect([later.parts.minutes, later.parts.seconds]).toEqual([10, 0]);
  });

  it("is closed once the deadline passed or the server says it is no longer cancellable", () => {
    const clock = clockFromServer(deadline + 1000, NOW);
    expect(cancelWindow(attempt({ cancelDeadlineMs: deadline }), clock, NOW).kind).toBe("closed");
    expect(cancelWindow(attempt({ cancellable: false }), clockFromServer(NOW, NOW), NOW).kind).toBe("closed");
    expect(cancelWindow(attempt({ state: "PURCHASED" }), clockFromServer(NOW, NOW), NOW).kind).toBe("closed");
  });

  it("without a server timestamp it shows the deadline only and never computes a countdown", () => {
    const w = cancelWindow(attempt({ cancelDeadlineMs: deadline }), null, NOW);
    expect(w).toEqual({ kind: "deadline", deadlineMs: deadline });
  });
});

describe("rule list", () => {
  it("orders armed first, flags paused rules and surfaces attempts that need attention", () => {
    const rows = buildRuleRows({
      paused: false, serverNowMs: NOW,
      rules: [
        rule({ id: "e", status: "EXPIRED" }),
        rule({ id: "a", latestAttempt: attempt() }),
        rule({ id: "p", status: "PURCHASED" }),
        rule({ id: "z", paused: true }),
      ],
    });
    expect(rows.map((r) => [r.rule.id, r.badge])).toEqual([["a", "armed"], ["z", "paused"], ["p", "purchased"], ["e", "expired"]]);
    expect(rows[0]?.attention?.id).toBe(ATT);
    expect(rows[0]?.canCancel).toBe(true);
    expect(rows[3]?.canCancel).toBe(false);
  });

  it("a paused list (kill switch) shows every armed rule as paused", () => {
    const rows = buildRuleRows({ paused: true, serverNowMs: null, rules: [rule()] });
    expect(rows[0]?.badge).toBe("paused");
  });
});

describe("in-memory port", () => {
  const draft = (over: Partial<AutoBuyDraft> = {}): AutoBuyDraft => ({
    skuId: SKU, sizeLabel: "M", targetPrice: 64_900n, maxPrice: 70_000n, expiresAtMs: NOW + 86_400_000, mode: "notifyConfirm", termsVersion: 3, locale: "en", paymentTokenRef: null, ...over,
  });
  it("creates once per idempotency key and refuses a second active rule for the same item", async () => {
    const p = new InMemoryAutoBuyPort(FIXTURE_CAPABILITIES, null, () => NOW);
    const a = await p.create(draft(), "k1");
    const b = await p.create(draft(), "k1");
    expect(a).toEqual(b);
    expect((await p.list()).rules).toHaveLength(1);
    expect(await p.create(draft(), "k2")).toEqual({ kind: "refused", reason: "duplicate" });
  });
  it("a stale mandate version is refused with the current one", async () => {
    const p = new InMemoryAutoBuyPort(FIXTURE_CAPABILITIES, null, () => NOW, 4);
    expect(await p.create(draft({ termsVersion: 3 }), "k")).toEqual({ kind: "termsStale", currentVersion: 4 });
  });
  it("unattended is refused when the server does not offer it", async () => {
    const p = new InMemoryAutoBuyPort(FIXTURE_CAPABILITIES, null, () => NOW);
    expect(await p.create(draft({ mode: "unattended", paymentTokenRef: "tok_12345678" }), "k")).toEqual({ kind: "refused", reason: "unattendedUnavailable" });
  });
  it("cancelling a rule or an attempt updates state; failures surface as PortError", async () => {
    const p = new InMemoryAutoBuyPort(FIXTURE_CAPABILITIES, null, () => NOW);
    p.seed([rule({ latestAttempt: attempt() })]);
    await p.cancelAttempt(ATT);
    expect((await p.list()).rules[0]?.latestAttempt?.state).toBe("CANCELLED_BY_USER");
    await p.cancelRule(RULE);
    expect((await p.list()).rules[0]?.status).toBe("DISARMED");
    p.setFailure("offline");
    await expect(p.list()).rejects.toBeInstanceOf(PortError);
  });
});

const egp = (n: number) => ({ amount: String(n), currency: "EGP" as const });
const wireAttempt = {
  id: ATT, state: "NOTIFIED", mode: "unattended", notice_sent_at: "2026-10-11T10:00:00Z", cancel_deadline: "2026-10-11T10:15:00Z", cancellable: true,
  failure_reason: "", order_group_id: ORDER, created_at: "2026-10-11T10:00:00Z",
};
const wireRule = {
  id: RULE, sku_id: SKU, size_label: "M", target_price: egp(64_900), max_price: egp(70_000), mode: "notify_confirm", status: "ARMED", closed_reason: "", paused: false,
  payment_method: "saved_card", expires_at: "2026-11-10T10:00:00Z", accepted_at: "2026-10-11T10:00:00Z", terms_version: 3, latest_attempt: wireAttempt, created_at: "2026-10-11T10:00:00Z",
};

const listMeta = { paused: false, server_time: "2026-10-11T10:05:00Z", capabilities: { unattended_available: false } };

describe("ApiAutoBuyPort", () => {
  it("maps the rule list; blank strings become null and the server time anchors the clock", async () => {
    const { ctx } = fakeApi({ "GET /v1/me/auto-buy": () => ({ body: { ...listMeta, items: [wireRule] } }) });
    const l = await new ApiAutoBuyPort(ctx).list();
    expect(l.serverNowMs).toBe(Date.parse("2026-10-11T10:05:00Z"));
    expect(l.rules[0]).toMatchObject({ id: RULE, targetPrice: 64_900n, maxPrice: 70_000n, mode: "notifyConfirm", closedReason: null });
    expect(l.rules[0]?.latestAttempt).toMatchObject({ state: "NOTIFIED", mode: "unattended", failureReason: null, orderGroupId: ORDER, cancellable: true });
  });

  it("capabilities mirror the paused flag and the server unattended capability", async () => {
    const { ctx } = fakeApi({ "GET /v1/me/auto-buy": () => ({ body: { ...listMeta, paused: true, items: [] } }) });
    expect(await new ApiAutoBuyPort(ctx).capabilities()).toEqual({ enabled: false, unattendedAvailable: false, savedCard: null, passkeySession: null });
  });

  it("unattended is offered only when the server says so", async () => {
    const { ctx } = fakeApi({ "GET /v1/me/auto-buy": () => ({ body: { ...listMeta, capabilities: { unattended_available: true }, items: [] } }) });
    expect((await new ApiAutoBuyPort(ctx).capabilities()).unattendedAvailable).toBe(true);
  });

  it("the mandate text and version come from the terms endpoint, verbatim", async () => {
    const { ctx, calls } = fakeApi({ "GET /v1/me/auto-buy/terms": () => ({ body: { version: 4, locale: "ar", text: "نص {{item}}" } }) });
    expect(await new ApiAutoBuyPort(ctx).terms("ar")).toEqual({ version: 4, locale: "ar", text: "نص {{item}}" });
    expect(calls[0]?.query.get("locale")).toBe("ar");
  });

  it("sca-complete posts with an idempotency key and maps the result", async () => {
    const { ctx, calls } = fakeApi({ [`POST /v1/me/auto-buy/attempts/${ATT}/sca-complete`]: () => ({ body: { status: "purchased", order_group_id: ORDER } }) });
    expect(await new ApiAutoBuyPort(ctx).completeSca(ATT, "k-sca-1")).toEqual({ status: "purchased", orderGroupId: ORDER });
    expect(calls[0]?.headers["Idempotency-Key"]).toBe("k-sca-1");
  });

  it("create sends the accepted mandate version, money as strings and the idempotency key", async () => {
    const { ctx, calls } = fakeApi({ "POST /v1/me/auto-buy": () => ({ status: 201, body: { ...wireRule, terms: { version: 3, locale: "en", text: "t" } } }) });
    const out = await new ApiAutoBuyPort(ctx).create(
      { skuId: SKU, sizeLabel: "M", targetPrice: 64_900n, maxPrice: 70_000n, expiresAtMs: Date.parse("2026-11-10T10:00:00Z"), mode: "notifyConfirm", termsVersion: 3, locale: "en", paymentTokenRef: null },
      "idem-key-1",
    );
    expect(out.kind).toBe("created");
    expect(calls[0]?.headers["Idempotency-Key"]).toBe("idem-key-1");
    expect(calls[0]?.body).toEqual({
      sku_id: SKU, size_label: "M", target_price: egp(64_900), max_price: egp(70_000), expires_at: "2026-11-10T10:00:00.000Z", mode: "notify_confirm", locale: "en", accepted_terms_version: 3,
    });
  });

  it("maps refusals: step-up, stale terms (with current version), unattended unavailable, kill switch", async () => {
    const run = async (r: ReturnType<typeof problem>) => {
      const { ctx } = fakeApi({ "POST /v1/me/auto-buy": () => r });
      return new ApiAutoBuyPort(ctx).create(
        { skuId: SKU, sizeLabel: "M", targetPrice: 1n, maxPrice: 2n, expiresAtMs: NOW, mode: "notifyConfirm", termsVersion: 1, locale: "en", paymentTokenRef: null }, "k",
      );
    };
    expect(await run(problem(403, "step_up_required"))).toEqual({ kind: "refused", reason: "stepUpRequired" });
    expect(await run(problem(409, "terms_version_stale", { current_version: 5 }))).toEqual({ kind: "termsStale", currentVersion: 5 });
    expect(await run(problem(422, "unattended_unavailable"))).toEqual({ kind: "refused", reason: "unattendedUnavailable" });
    expect(await run(problem(404, "not_found"))).toEqual({ kind: "refused", reason: "disabled" });
  });

  it("a server body that breaks the contract (null latest_attempt) surfaces as a failure, never as fake data", async () => {
    // docs/plan/api-client-gap.md: the server sends null here while the OpenAPI declares an object.
    const { ctx } = fakeApi({ "GET /v1/me/auto-buy": () => ({ body: { ...listMeta, items: [{ ...wireRule, latest_attempt: null }] } }) });
    const err = await new ApiAutoBuyPort(ctx).list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortError);
    expect((err as PortError & { cause?: unknown }).cause).toMatchObject({ name: "ContractDriftError" });
  });

  it("unknown failures are never swallowed as refusals", () => {
    expect(() => createOutcomeFromError(new Error("boom"))).toThrow(PortError);
  });

  it("cancel rule and attempt hit the documented routes with idempotency keys; alerts are price_drop", async () => {
    const { ctx, calls } = fakeApi({
      [`DELETE /v1/me/auto-buy/${RULE}`]: () => ({ body: { status: "cancelled" } }),
      [`POST /v1/me/auto-buy/attempts/${ATT}/cancel`]: () => ({ body: { status: "cancelled" } }),
      [`POST /v1/products/${SKU}/alerts`]: () => ({ status: 201, body: { id: RULE, product_id: SKU, type: "price_drop", sku_id: SKU, target_price: egp(50_000), created_at: "2026-10-11T10:00:00Z" } }),
    });
    const p = new ApiAutoBuyPort(ctx);
    await p.cancelRule(RULE, "k1");
    await p.cancelAttempt(ATT, "k2");
    await p.notifyAtTarget(SKU, SKU, 50_000n, "k3");
    expect(calls.map((c) => [c.method, c.headers["Idempotency-Key"]])).toEqual([["DELETE", "k1"], ["POST", "k2"], ["POST", "k3"]]);
    expect(calls[2]?.body).toEqual({ type: "price_drop", sku_id: SKU, target_price: egp(50_000) });
  });

  it("ruleFromWire exposes the status and expiry the screen shows", () => {
    const parsed = ruleFromWire({ ...wireRule, mode: "unattended", status: "PURCHASED", payment_method: "saved_card" } as never);
    expect(parsed.status).toBe("PURCHASED");
    expect(parsed.expiresAtMs).toBe(Date.parse("2026-11-10T10:00:00Z"));
  });
});
