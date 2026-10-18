import { describe, expect, it } from "vitest";
import {
  FixedClock,
  InMemoryCreatorCatalog,
  InMemoryCreatorIdentity,
  InMemoryCreatorLedger,
  InMemoryCreatorReferrals,
  InMemoryCreatorStore,
  StaticCreatorFlags,
  FakeKycVault,
  StaticTerms,
} from "../adapters/in-memory";
import { AccrueClosedLine, ApplyLineRefund, PostCommissionIntents } from "../application/commissions";
import { ApplyAsCreator, DecideCreator } from "../application/accounts";
import { CreatorEventConsumer, CreatorEventDeferredError } from "../application/events";
import { AttributeOrder, CreateLink, RecordClick } from "../application/links";
import { DEFAULT_CREATOR_CONFIG } from "../domain/bridge";
import type { CreatorProfileView } from "../domain/ports";

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T0 = Date.UTC(2026, 9, 12, 8, 0, 0);
const DAY = 86_400_000;
const hex = (c: string): string => c.repeat(64);
let seq = 0;
const ids = { uuidV7: (): string => `00000000-0000-7000-8000-${String(++seq).padStart(12, "0")}` };
const entropy = { randomBytes: (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + ++seq) & 0xff) };

const profile = (userId: string, o: Partial<CreatorProfileView> = {}): CreatorProfileView => ({
  userId,
  ageYears: 30,
  active: true,
  deviceHashes: [],
  paymentFingerprintHashes: [],
  addressHashes: [],
  sellerStoreIds: [],
  ...o,
});

function world() {
  const store = new InMemoryCreatorStore();
  const identity = new InMemoryCreatorIdentity();
  const catalog = new InMemoryCreatorCatalog();
  const ledger = new InMemoryCreatorLedger();
  const flags = new StaticCreatorFlags(true, false);
  const clock = new FixedClock(T0);
  const o = { config: DEFAULT_CREATOR_CONFIG, bankAccount: "b", linkBase: "https://x.invalid/c", clickSalt: "test-click-salt-0123456789abcdef0123" };
  const poster = new PostCommissionIntents(store, ledger, clock, ids);
  const referrals = new InMemoryCreatorReferrals();
  const attribute = new AttributeOrder(store, identity, flags, clock, o, referrals);
  const consumer = new CreatorEventConsumer(new AccrueClosedLine(store, poster, ids, o, clock), new ApplyLineRefund(store, poster), attribute);
  const apply = new ApplyAsCreator(store, identity, new FakeKycVault(), new StaticTerms(1), flags, clock, ids, o);
  const decide = new DecideCreator(store, identity, clock, o);
  const createLink = new CreateLink(store, identity, catalog, flags, clock, ids, entropy, o);
  const click = new RecordClick(store, flags, clock, ids, o);
  return { store, identity, catalog, ledger, clock, consumer, apply, decide, createLink, click };
}
type World = ReturnType<typeof world>;

/** Creator U(1) with a click from buyer U(2)'s device; returns the click time. */
async function seed(w: World): Promise<void> {
  w.identity.profiles.set(U(1), profile(U(1)));
  const r = await w.apply.execute(U(1), {
    handle: "creator_1",
    displayName: "Creator 1",
    legalName: "Legal 1",
    nationalId: "29901010000001",
    payoutIban: null,
    payoutName: null,
    taxId: null,
    taxForm: null,
    acceptTermsVersion: 1,
  });
  if (r.kind !== "applied") throw new Error(r.kind);
  const d = await w.decide.execute({ creatorId: r.account.id, action: "approve", reason: "auto-checks:ok ref-test", reviewerId: U(9) });
  if (d.kind !== "ok") throw new Error("approve");
  w.catalog.targets.set(`product:${U(300)}`, { exists: true, storeId: U(1000) });
  const l = await w.createLink.execute(U(1), "product", U(300));
  if (l.kind !== "created" && l.kind !== "exists") throw new Error(l.kind);
  w.identity.profiles.set(U(2), profile(U(2), { deviceHashes: [hex("b")] }));
  await w.click.execute({ slug: l.link.slug, deviceHash: hex("b"), ipHash: hex("9"), uaClass: "app" });
  w.clock.ms += 1000;
}

const paid = (over: object = {}) => ({
  messageId: U(5001),
  type: "order_group.paid",
  occurredAtMs: T0 + 1000,
  payload: { order_group_id: U(400), user_id: U(2), method: "card", total: "114000", sku_ids: U(300), paid_at_ms: T0 + 1000 },
  ...over,
});
const closed = (messageId: string, over: Record<string, unknown> = {}) => ({
  messageId,
  type: "order_line.closed",
  payload: {
    order_group_id: U(400),
    order_line_id: U(700),
    category_id: null,
    merchandise_gross: "114000",
    voucher_allocated: "0",
    refunded_merchandise_gross: "0",
    closed_at_ms: T0 + 15 * DAY,
    return_window_ends_at_ms: T0,
    open_returns: 0,
    ...over,
  },
});
const refunded = (messageId: string, cumulative: string, over: Record<string, unknown> = {}) => ({
  messageId,
  type: "order_line.refunded",
  payload: { order_line_id: U(700), line_merchandise_gross: "114000", refunded_merchandise_gross: cumulative, ...over },
});

describe("creators event consumer", () => {
  it("order_group.paid attributes once; the same message and a different message id are both no-ops", async () => {
    const w = world();
    await seed(w);
    expect(await w.consumer.handle(paid())).toBe("handled");
    const first = await w.store.getAttribution(U(400));
    expect(first).toMatchObject({ status: "ACTIVE", buyerUserId: U(2) });
    expect(await w.consumer.handle(paid())).toBe("handled");
    expect(await w.consumer.handle(paid({ messageId: U(5002) }))).toBe("handled");
    expect(await w.store.getAttribution(U(400))).toEqual(first);
  });

  it("COD confirmation is attributed the same way", async () => {
    const w = world();
    await seed(w);
    expect(await w.consumer.handle(paid({ type: "order_group.cod_confirmed" }))).toBe("handled");
    expect((await w.store.getAttribution(U(400)))?.status).toBe("ACTIVE");
  });

  it("an order without a creator click is handled with no attribution", async () => {
    const w = world();
    await seed(w);
    w.identity.profiles.set(U(3), profile(U(3), { deviceHashes: [hex("c")] }));
    const r = await w.consumer.handle(paid({ payload: { order_group_id: U(401), user_id: U(3), paid_at_ms: T0 + 1000 } }));
    expect(r).toBe("handled");
    expect(await w.store.getAttribution(U(401))).toBeNull();
  });

  it("order_line.closed accrues once and posts one balanced entry; redelivery has no second effect", async () => {
    const w = world();
    await seed(w);
    await w.consumer.handle(paid());
    expect(await w.consumer.handle(closed(U(6001)))).toBe("handled");
    expect(w.ledger.entries.size).toBe(1);
    expect(await w.ledger.payableBalance(U(1))).toBe(3_000n);
    // the same message again, and the same line under a new message id
    expect(await w.consumer.handle(closed(U(6001)))).toBe("duplicate");
    expect(await w.consumer.handle(closed(U(6002)))).toBe("handled");
    expect(w.ledger.entries.size).toBe(1);
    expect(await w.ledger.payableBalance(U(1))).toBe(3_000n);
    expect(w.ledger.trialBalance()).toBe(0n);
  });

  it("A-9: open return, longer window, or payloads without the facts are retried and never accrue", async () => {
    const w = world();
    await seed(w);
    await w.consumer.handle(paid());
    await expect(w.consumer.handle(closed(U(6101), { open_returns: 1 }))).rejects.toBeInstanceOf(CreatorEventDeferredError);
    await expect(w.consumer.handle(closed(U(6102), { return_window_ends_at_ms: T0 + 45 * DAY }))).rejects.toBeInstanceOf(CreatorEventDeferredError);
    await expect(w.consumer.handle(closed(U(6103), { return_window_ends_at_ms: undefined, open_returns: undefined }))).rejects.toBeInstanceOf(CreatorEventDeferredError);
    expect(w.ledger.entries.size).toBe(0);
    expect(await w.consumer.handle(closed(U(6104)))).toBe("handled");
    expect(w.ledger.entries.size).toBe(1);
  });

  it("a line closed with part already refunded accrues on the remainder only", async () => {
    const w = world();
    await seed(w);
    await w.consumer.handle(paid());
    await w.consumer.handle(closed(U(6001), { refunded_merchandise_gross: "57000" }));
    expect(await w.ledger.payableBalance(U(1))).toBe(1_500n);
  });

  it("order_line.refunded claws back once; same cumulative again claws back nothing", async () => {
    const w = world();
    await seed(w);
    await w.consumer.handle(paid());
    await w.consumer.handle(closed(U(6001)));
    expect(await w.consumer.handle(refunded(U(7001), "57000"))).toBe("handled");
    expect(await w.ledger.payableBalance(U(1))).toBe(1_500n);
    expect(await w.consumer.handle(refunded(U(7001), "57000"))).toBe("duplicate");
    expect(await w.consumer.handle(refunded(U(7002), "57000"))).toBe("handled");
    expect(await w.ledger.payableBalance(U(1))).toBe(1_500n);
    // a later, larger cumulative moves only the difference; a smaller one never gives money back
    await w.consumer.handle(refunded(U(7003), "114000"));
    expect(await w.ledger.payableBalance(U(1))).toBe(0n);
    await w.consumer.handle(refunded(U(7004), "10"));
    expect(await w.ledger.payableBalance(U(1))).toBe(0n);
    expect(w.ledger.trialBalance()).toBe(0n);
  });

  it("a refund for a line with no commission yet is acknowledged, and closure later accrues net of it", async () => {
    const w = world();
    await seed(w);
    await w.consumer.handle(paid());
    expect(await w.consumer.handle(refunded(U(7001), "57000"))).toBe("handled");
    expect(w.ledger.entries.size).toBe(0);
    await w.consumer.handle(closed(U(6001), { refunded_merchandise_gross: "57000" }));
    expect(await w.ledger.payableBalance(U(1))).toBe(1_500n);
  });

  it("a held attribution defers (throws for relay retry) and accrues once the identity is back", async () => {
    const w = world();
    await seed(w);
    w.identity.profiles.delete(U(1));
    await expect(w.consumer.handle(paid())).rejects.toBeInstanceOf(CreatorEventDeferredError);
    await expect(w.consumer.handle(closed(U(6001)))).rejects.toBeInstanceOf(CreatorEventDeferredError);
    expect(w.ledger.entries.size).toBe(0);
    w.identity.profiles.set(U(1), profile(U(1)));
    expect(await w.consumer.handle(paid({ messageId: U(5003) }))).toBe("handled");
    expect(await w.consumer.handle(closed(U(6001)))).toBe("handled");
    expect(await w.ledger.payableBalance(U(1))).toBe(3_000n);
  });

  it("malformed payloads are invalid with no effect; unknown types are ignored", async () => {
    const w = world();
    await seed(w);
    expect(await w.consumer.handle({ messageId: U(1), type: "order_line.closed", payload: { order_line_id: "x" } })).toBe("invalid");
    expect(await w.consumer.handle(refunded(U(2), "1", { line_merchandise_gross: null }))).toBe("invalid");
    expect(await w.consumer.handle({ messageId: U(3), type: "order_group.paid", payload: {} })).toBe("invalid");
    expect(await w.consumer.handle({ messageId: U(4), type: "something.else", payload: {} })).toBe("ignored");
    expect(w.ledger.entries.size).toBe(0);
  });

  it("an order_group.paid from before the payload extension (no order_group_id) is invalid, not a crash", async () => {
    const w = world();
    await seed(w);
    const r = await w.consumer.handle({ messageId: U(9), type: "order_group.paid", payload: { user_id: U(2), method: "card", total: "1" } });
    expect(r).toBe("invalid");
  });
});
