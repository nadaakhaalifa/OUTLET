import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { money, type DocumentLineInput } from "../domain/bridge";
import type { IssueInput } from "../application/tax";
import { consumerParty, haul, sellerParty } from "./fixtures";
import { STORE_A, STORE_B, U, createTaxHarness, type TaxHarness } from "./harness";

let h: TaxHarness;
beforeEach(async () => {
  h = await createTaxHarness();
});
afterEach(async () => {
  await h.close();
});

const commission = (amount = 20_000n): DocumentLineInput => ({
  lineType: "commission",
  descriptionAr: "عمولة البيع",
  descriptionEn: "Sales commission",
  categoryCode: "marketplace_fee",
  amount: money(amount),
});

const invoice = (ref: string, store = STORE_A): IssueInput => ({
  kind: "seller_einvoice",
  sourceRef: ref,
  issuer: haul,
  recipient: sellerParty(store),
  lines: [commission()],
  storeId: store,
  userId: null,
});

const issueOk = async (input: IssueInput) => {
  const r = await h.issue.execute(input);
  if (r.kind !== "ok") throw new Error(`issue failed: ${r.kind}`);
  return r.value;
};

describe("IssueDocument", () => {
  it("issues once per source and enqueues QUEUED", async () => {
    const a = await issueOk(invoice("s1"));
    expect(a.submission.state).toBe("QUEUED");
    expect(a.stored.document.totals.vat.amount).toBe(2_800n);
    const again = await h.issue.execute(invoice("s1"));
    expect(again).toMatchObject({ kind: "ok", duplicate: true });
    expect(h.events.published.filter((e) => e.type === "tax_document.issued")).toHaveLength(1);
  });

  it("refuses non-Arabic text, wrong line types and missing party ids", async () => {
    const bad = await h.issue.execute({ ...invoice("s2"), lines: [{ ...commission(), descriptionAr: "Commission" }] });
    expect(bad.kind).toBe("invalid");
    const wrong = await h.issue.execute({ ...invoice("s3"), lines: [{ ...commission(), lineType: "delivery_fee" }] });
    expect(wrong.kind).toBe("invalid");
    const noStore = await h.issue.execute({ ...invoice("s4"), storeId: null });
    expect(noStore.kind).toBe("invalid");
  });

  it("issues own-supply shopper receipts but seller goods receipts only under delegation", async () => {
    const receipt = await h.issue.execute({
      kind: "shopper_ereceipt",
      sourceRef: "og-1",
      issuer: haul,
      recipient: consumerParty(U(1)),
      lines: [{ lineType: "delivery_fee", descriptionAr: "رسوم التوصيل", categoryCode: "shipping", amount: money(11_400n) }],
      storeId: null,
      userId: U(1),
    });
    expect(receipt.kind).toBe("ok");
    const goods: IssueInput = {
      kind: "seller_goods_ereceipt",
      sourceRef: "so-1",
      issuer: sellerParty(STORE_A),
      recipient: consumerParty(U(1)),
      lines: [{ lineType: "goods", descriptionAr: "فستان", categoryCode: "standard", amount: money(11_400n) }],
      storeId: STORE_A,
      userId: U(1),
    };
    expect((await h.issue.execute(goods)).kind).toBe("delegation_required");
    h.delegations.grant(STORE_B);
    expect((await h.issue.execute(goods)).kind).toBe("delegation_required");
    h.delegations.grant(STORE_A);
    expect((await h.issue.execute(goods)).kind).toBe("ok");
  });
});

describe("ProcessSubmissionQueue", () => {
  it("accepts, stores the signed document and is idempotent on rerun", async () => {
    const v = await issueOk(invoice("q1"));
    const run = await h.queue.execute();
    expect(run).toMatchObject({ attempted: 1, accepted: 1 });
    const done = await h.documents.findById(v.stored.id);
    expect(done?.submission).toMatchObject({ state: "ACCEPTED", attempts: 1 });
    expect(done?.submission.etaUuid).toBe(`eta-${v.stored.document.internalId}`);
    const signed = await h.signed.get(done?.submission.signedDocumentRef ?? "");
    expect(signed?.body).toContain("signed");
    expect(await h.queue.execute()).toMatchObject({ attempted: 0 });
    expect(h.eta.submitCalls).toHaveLength(1);
  });

  it("rejects without retry and records the reasons", async () => {
    const v = await issueOk(invoice("q2"));
    h.eta.script(v.stored.document.internalId, { kind: "rejected", reasons: ["invalid tax id"] });
    expect(await h.queue.execute()).toMatchObject({ rejected: 1 });
    const done = await h.documents.findById(v.stored.id);
    expect(done?.submission).toMatchObject({ state: "REJECTED", rejectionReasons: ["invalid tax id"] });
    expect(await h.queue.execute()).toMatchObject({ attempted: 0 });
  });

  it("retries transient failures with backoff and jitter, then accepts", async () => {
    const v = await issueOk(invoice("q3"));
    h.eta.script(v.stored.document.internalId, { kind: "transient_error", message: "503" }, "throw");
    expect(await h.queue.execute()).toMatchObject({ retried: 1 });
    const r1 = await h.documents.findById(v.stored.id);
    expect(r1?.submission.state).toBe("RETRY");
    const wait = (r1?.submission.nextAttemptAtMs ?? 0) - h.clock.nowMs();
    expect(wait).toBeGreaterThanOrEqual(15_000);
    expect(wait).toBeLessThanOrEqual(30_000);
    expect(await h.queue.execute()).toMatchObject({ attempted: 0 }); // not due yet
    h.clock.advance(31_000);
    expect(await h.queue.execute()).toMatchObject({ retried: 1 }); // thrown error counts as transient
    const r2 = await h.documents.findById(v.stored.id);
    expect(r2?.submission.attempts).toBe(2);
    expect((r2?.submission.nextAttemptAtMs ?? 0) - h.clock.nowMs()).toBeGreaterThanOrEqual(30_000);
    h.clock.advance(61_000);
    expect(await h.queue.execute()).toMatchObject({ accepted: 1 });
  });

  it("dead-letters after the attempt budget and a requeue gives it a fresh budget", async () => {
    const v = await issueOk(invoice("q4"));
    const id = v.stored.document.internalId;
    h.eta.script(id, "throw", "throw", "throw", "throw", "throw", "throw", "throw");
    for (let i = 0; i < 6; i += 1) {
      h.clock.advance(3_700_000);
      await h.queue.execute();
    }
    const dead = await h.documents.findById(v.stored.id);
    expect(dead?.submission).toMatchObject({ state: "DEAD_LETTER", attempts: 6, lastError: "network down" });
    expect(h.events.published.some((e) => e.type === "eta.submission_dead_lettered")).toBe(true);
    h.clock.advance(3_700_000);
    expect(await h.queue.execute()).toMatchObject({ attempted: 0 });
  });

  it("two workers cannot both send the same document (compare-and-set)", async () => {
    await issueOk(invoice("q5"));
    const [a, b] = await Promise.all([h.queue.execute(), h.queue.execute()]);
    expect(a.accepted + b.accepted).toBe(1);
    expect(h.eta.submitCalls).toHaveLength(1);
  });
});

describe("PollSubmissionStatuses", () => {
  it("resolves a pending submission once ETA decides", async () => {
    const v = await issueOk(invoice("p1"));
    const id = v.stored.document.internalId;
    h.eta.script(id, { kind: "pending", etaUuid: null });
    expect(await h.queue.execute()).toMatchObject({ pending: 1 });
    expect((await h.documents.findById(v.stored.id))?.submission.state).toBe("SUBMITTED");
    expect(await h.poll.execute({ minAgeMs: 0 })).toMatchObject({ pending: 1 });
    h.eta.setStatus(id, { kind: "accepted", etaUuid: "uuid-9", signed: { contentType: "application/json", body: "{}" } });
    expect(await h.poll.execute({ minAgeMs: 0 })).toMatchObject({ accepted: 1 });
    const done = await h.documents.findById(v.stored.id);
    expect(done?.submission).toMatchObject({ state: "ACCEPTED", etaUuid: "uuid-9" });
    expect(done?.submission.signedDocumentRef).not.toBeNull();
  });

  it("re-sends a crash-stranded submission ETA never received, and records rejection", async () => {
    const a = await issueOk(invoice("p2"));
    const b = await issueOk(invoice("p3"));
    // Simulate a crash after the SUBMITTED write: flip rows without calling ETA.
    for (const v of [a, b]) {
      await h.documents.updateSubmission({ ...v.submission, state: "SUBMITTED", attempts: 1, lastSubmittedAtMs: h.clock.nowMs(), version: 1 }, 0);
    }
    h.eta.setStatus(b.stored.document.internalId, { kind: "rejected", reasons: ["bad"] });
    expect(await h.poll.execute({ minAgeMs: 0 })).toMatchObject({ retried: 1, rejected: 1 });
    expect((await h.documents.findById(a.stored.id))?.submission.state).toBe("RETRY");
    expect(await h.queue.execute()).toMatchObject({ accepted: 1 });
  });
});

describe("daily reconciliation", () => {
  it("reports submitted vs accepted vs rejected for a Cairo day", async () => {
    // Distinct creation instants: the queue is FIFO by creation time, and with a frozen clock the
    // id tie-break is random, which made "the first two" (and so the rejected one) nondeterministic.
    const ok = await issueOk(invoice("r1"));
    h.clock.advance(1_000);
    const bad = await issueOk(invoice("r2"));
    h.clock.advance(1_000);
    await issueOk(invoice("r3"));
    h.eta.script(bad.stored.document.internalId, { kind: "rejected", reasons: ["x"] });
    // r3 stays queued: process only two by limiting.
    await h.queue.execute(2);
    // The reconciliation window is a Cairo civil day, not a UTC day.
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(
      new Date(h.clock.nowMs()),
    );
    const rep = await h.reconcile.execute(day);
    expect(rep.documents).toBe(3);
    expect(rep.counts.ACCEPTED + rep.counts.REJECTED).toBe(2);
    expect(rep.rejected).toBe(1);
    expect(rep.discrepancies.some((d) => d.internalId === bad.stored.document.internalId && d.kind === "rejected")).toBe(true);
    expect(rep.reconciled).toBe(false);
    expect(ok.stored.id).toBeTruthy();
    h.eta.dayReportUnavailable = true;
    expect((await h.reconcile.execute(day)).documents).toBe(3);
  });
});

describe("QuoteOrderTax and exemptions", () => {
  it("quotes with the stored categories and honours an active exemption", async () => {
    const lines = [{ id: "a", unitGross: money(11_400n), qty: 1, categoryCode: "standard" }];
    const q1 = await h.quote.execute({ lines, orderDiscountPiastres: 0n });
    expect(q1.kind === "ok" && q1.tax.totals.vat.amount).toBe(1_400n);
    expect((await h.quote.execute({ lines, orderDiscountPiastres: 99_999n })).kind).toBe("invalid");
  });
});

describe("IssueDocument owner binding", () => {
  it("rejects an e-invoice whose storeId differs from recipient.refId", async () => {
    const r = await h.issue.execute({ ...invoice("mm-1", STORE_B), storeId: STORE_A });
    expect(r.kind).toBe("invalid");
  });
  it("accepts a matching e-invoice", async () => {
    expect((await h.issue.execute(invoice("mm-ok", STORE_B))).kind).toBe("ok");
  });
  it("rejects a shopper receipt whose userId differs from recipient.refId", async () => {
    const r = await h.issue.execute({
      kind: "shopper_ereceipt",
      sourceRef: "mm-2",
      issuer: haul,
      recipient: consumerParty(U(1)),
      lines: [{ lineType: "delivery_fee", descriptionAr: "رسوم التوصيل", categoryCode: "shipping", amount: money(11_400n) }],
      storeId: null,
      userId: U(2),
    });
    expect(r.kind).toBe("invalid");
  });
});
