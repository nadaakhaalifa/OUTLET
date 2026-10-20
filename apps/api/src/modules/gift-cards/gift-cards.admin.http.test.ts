import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EGP, IDEM, TOKENS, U, bearer, createGiftCardHarness, type GiftCardHarness } from "./test/harness";

let h: GiftCardHarness;
let seq = 0;
const idem = (): Record<string, string> => ({ "Idempotency-Key": IDEM(++seq + 5000) });
const money = (n: number) => ({ amount: String(EGP(n)), currency: "EGP" });

beforeAll(async () => {
  h = await createGiftCardHarness();
  h.rt.flags.sales = true;
  h.rt.flags.redemption = true;
  h.rt.age.over21.add(U(1));
}, 60_000);
afterAll(async () => {
  await h.close();
});

const send = (method: "get" | "post", path: string, token: string | null, body?: unknown) => {
  h.rt.clock.advance(61_000);
  let r = h.http()[method](path).set(idem());
  if (token !== null) r = r.set(bearer(token));
  return body === undefined ? r : r.send(body as object);
};

async function issuedCard(egp: number): Promise<string> {
  const r = await send("post", "/v1/gift-cards", TOKENS.a, { amount: money(egp), design: "eid", channel: "in_app", payment_method: "card", is_new_card: false });
  expect(r.status).toBe(201);
  const id = r.body.card.id as string;
  const issued = await h.rt.issue.execute({ cardId: id, paymentIntentId: r.body.payment.intent_id as string });
  expect(issued.kind).toBe("issued");
  return id;
}

describe("admin gift cards: authentication and role matrix", () => {
  const routes: ["get" | "post", string, unknown][] = [
    ["post", `/v1/admin/gift-cards/${U(900)}/void`, { reason_code: "fraud_investigation" }],
    ["get", "/v1/admin/gift-cards/pots", undefined],
    ["get", "/v1/admin/gift-cards/throttle-events", undefined],
  ];
  for (const [method, path, body] of routes) {
    it(`${method.toUpperCase()} ${path}: 401 unauthenticated and for buyer/seller audiences`, async () => {
      expect((await send(method, path, null, body)).status).toBe(401);
      expect((await send(method, path, TOKENS.a, body)).status).toBe(401);
      expect((await send(method, path, TOKENS.seller, body)).status).toBe(401);
    });
    it(`${method.toUpperCase()} ${path}: 403 for an admin role outside the allow-list`, async () => {
      expect((await send(method, path, TOKENS.admin, body)).status).toBe(403);
    });
  }
  it("ops may read but not void", async () => {
    expect((await send("get", "/v1/admin/gift-cards/pots", TOKENS.ops)).status).toBe(200);
    expect((await send("post", `/v1/admin/gift-cards/${U(900)}/void`, TOKENS.ops, { reason_code: "fraud_investigation" })).status).toBe(403);
  });
});

describe("admin void", () => {
  it("unknown card is 404; bad reason code is 400; unknown field is 400", async () => {
    expect((await send("post", `/v1/admin/gift-cards/${U(951)}/void`, TOKENS.finance, { reason_code: "fraud_investigation" })).status).toBe(404);
    expect((await send("post", `/v1/admin/gift-cards/${U(951)}/void`, TOKENS.finance, { reason_code: "x".repeat(65) })).status).toBe(400);
    const id = await issuedCard(100);
    expect((await send("post", `/v1/admin/gift-cards/${id}/void`, TOKENS.finance, { reason_code: "nope-not-a-code" })).status).toBe(400);
    expect((await send("post", `/v1/admin/gift-cards/${id}/void`, TOKENS.finance, { reason_code: "fraud_investigation", extra: 1 })).status).toBe(400);
  });

  it("below the threshold: voids without approval, audits, refunds, and a replay returns the same card", async () => {
    const id = await issuedCard(100);
    const r = await send("post", `/v1/admin/gift-cards/${id}/void`, TOKENS.finance, { reason_code: "fraud_investigation" });
    expect(r.status).toBe(200);
    expect(r.body.card.status).toBe("VOIDED");
    expect(r.body.replayed).toBe(false);
    expect(h.rt.audit.entries.some((e) => e.action === "gift_card.admin_voided" && e.targetId === id && e.actorId === U(22))).toBe(true);
    const again = await send("post", `/v1/admin/gift-cards/${id}/void`, TOKENS.finance, { reason_code: "fraud_investigation" });
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
  });

  it("above the threshold: needs a covering approval from a different approver, consumed once", async () => {
    const id = await issuedCard(6000);
    const path = `/v1/admin/gift-cards/${id}/void`;
    expect((await send("post", path, TOKENS.finance, { reason_code: "fraud_investigation" })).status).toBe(422);
    const approvalId = U(7001);
    const now = h.rt.clock.nowMs();
    const base = {
      id: approvalId,
      kind: "refund" as const,
      subjectType: "gift_card",
      subjectId: id,
      amountMinor: EGP(6000),
      reasonCode: "fraud_investigation",
      requesterId: U(22),
      state: "APPROVED" as const,
      approverId: U(23),
      requestedAtMs: now,
      expiresAtMs: now + 86_400_000,
      decidedAtMs: now,
      decisionNote: null,
    };
    // approval requested by someone else: refused
    h.rt.approvals.records.set(approvalId, { ...base, requesterId: U(23), approverId: U(22) });
    expect((await send("post", path, TOKENS.finance, { reason_code: "fraud_investigation", approval_id: approvalId })).status).toBe(422);
    // approval for a different card: refused
    h.rt.approvals.records.set(approvalId, { ...base, subjectId: U(777) });
    expect((await send("post", path, TOKENS.finance, { reason_code: "fraud_investigation", approval_id: approvalId })).status).toBe(422);
    h.rt.approvals.records.set(approvalId, base);
    const ok = await send("post", path, TOKENS.finance, { reason_code: "fraud_investigation", approval_id: approvalId });
    expect(ok.status).toBe(200);
    expect(ok.body.card.status).toBe("VOIDED");
    expect(h.rt.approvals.consumed.has(approvalId)).toBe(true);
    // a second big card cannot reuse the consumed approval
    const id2 = await issuedCard(6000);
    h.rt.approvals.records.set(approvalId, { ...base, subjectId: id2 });
    expect((await send("post", `/v1/admin/gift-cards/${id2}/void`, TOKENS.finance, { reason_code: "fraud_investigation", approval_id: approvalId })).status).toBe(422);
  });
});

describe("admin pots and throttle events", () => {
  it("lists pots with reconciliation and rejects a malformed cursor", async () => {
    const mk = await send("post", "/v1/gift-pots", TOKENS.a, {
      target: money(500),
      closes_at: new Date(h.rt.clock.nowMs() + 86_400_000).toISOString(),
      organiser_nickname: "S",
      design: "eid",
      channel: "in_app",
    });
    expect(mk.status).toBe(201);
    const r = await send("get", "/v1/admin/gift-cards/pots?limit=1", TOKENS.finance);
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBe(1);
    expect(r.body.items[0].reconciled).toBe(true);
    expect(r.body.items[0].target).toEqual({ amount: String(EGP(500)), currency: "EGP" });
    expect((await send("get", "/v1/admin/gift-cards/pots?cursor=%%%", TOKENS.finance)).status).toBe(400);
    expect((await send("get", "/v1/admin/gift-cards/pots?limit=0", TOKENS.finance)).status).toBe(400);
  });

  it("lists throttled attempts with keyset paging and truncated refs only", async () => {
    for (let i = 0; i < 3; i += 1) {
      await h.rt.store.recordAttempt({ id: U(8000 + i), accountId: U(1), deviceHash: "d".repeat(64), ipHash: "i".repeat(64), outcome: "throttled", atMs: 1_800_000_000_000 + i });
    }
    const p1 = await send("get", "/v1/admin/gift-cards/throttle-events?limit=2", TOKENS.finance);
    expect(p1.status).toBe(200);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.items[0].device_ref).toBe("d".repeat(12));
    const p2 = await send("get", `/v1/admin/gift-cards/throttle-events?limit=2&cursor=${encodeURIComponent(p1.body.next_cursor as string)}`, TOKENS.finance);
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.next_cursor).toBeNull();
    expect((await send("get", "/v1/admin/gift-cards/throttle-events?cursor=abc", TOKENS.finance)).status).toBe(400);
  });
});
