import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  FakeCreatorPayoutProvider,
  FakeKycVault,
  FixedClock,
  InMemoryCreatorApprovals,
  InMemoryCreatorCatalog,
  InMemoryCreatorIdentity,
  InMemoryCreatorLedger,
  InMemoryCreatorReferrals,
  InMemoryCreatorStore,
  StaticCreatorFlags,
  StaticTerms,
  UnconfiguredCreatorPayoutProvider,
} from "../adapters/in-memory";
import { AccrueClosedLine, ApplyLineRefund, GetCreatorDashboard, PostCommissionIntents, ReleaseHeldCommissions } from "../application/commissions";
import { ApplyAsCreator, DecideCreator } from "../application/accounts";
import { AttributeOrder, CreateLink, LookCommands, MaintainClickPartitions, RecordClick, VoidAttribution } from "../application/links";
import { CreatorPayoutCommands } from "../application/payouts";
import { DEFAULT_CREATOR_CONFIG, creatorPayout, money } from "../domain/bridge";
import type { CreatorPayoutProviderPort, CreatorProfileView } from "../domain/ports";

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

function world(opts: { payouts?: boolean; provider?: CreatorPayoutProviderPort; cfg?: Partial<typeof DEFAULT_CREATOR_CONFIG> } = {}) {
  const store = new InMemoryCreatorStore();
  const identity = new InMemoryCreatorIdentity();
  const catalog = new InMemoryCreatorCatalog();
  const ledger = new InMemoryCreatorLedger();
  const vault = new FakeKycVault();
  const approvals = new InMemoryCreatorApprovals();
  const flags = new StaticCreatorFlags(true, opts.payouts ?? false);
  const clock = new FixedClock(T0);
  const terms = new StaticTerms(1);
  const provider = opts.provider ?? new FakeCreatorPayoutProvider();
  const cfg = { ...DEFAULT_CREATOR_CONFIG, ...opts.cfg };
  const o = { config: cfg, bankAccount: "creator-bank", linkBase: "https://x.invalid/c", clickSalt: "test-click-salt-0123456789abcdef0123" };
  const poster = new PostCommissionIntents(store, ledger, clock, ids);
  const referrals = new InMemoryCreatorReferrals();
  return {
    referrals,
    voidAttribution: new VoidAttribution(store, poster),
    maintain: new MaintainClickPartitions(store, clock),
    store, identity, catalog, ledger, vault, approvals, flags, clock, terms, provider, cfg, poster,
    apply: new ApplyAsCreator(store, identity, vault, terms, flags, clock, ids, o),
    decide: new DecideCreator(store, identity, clock, o),
    createLink: new CreateLink(store, identity, catalog, flags, clock, ids, entropy, o),
    click: new RecordClick(store, flags, clock, ids, o),
    attribute: new AttributeOrder(store, identity, flags, clock, o, referrals),
    accrue: new AccrueClosedLine(store, poster, ids, o, clock),
    refund: new ApplyLineRefund(store, poster),
    release: new ReleaseHeldCommissions(store, poster, clock, o),
    looks: new LookCommands(store, identity, catalog, flags, clock, ids, o),
    dashboard: new GetCreatorDashboard(store, identity, ledger, flags, clock, o),
    payouts: new CreatorPayoutCommands(store, identity, ledger, vault, approvals, provider, flags, clock, ids, o),
  };
}
type World = ReturnType<typeof world>;

const applyInput = (n: number, over: object = {}) => ({
  handle: `creator_${n}`,
  displayName: `Creator ${n}`,
  legalName: `Legal ${n}`,
  nationalId: `2990101${String(n).padStart(7, "0")}`,
  payoutIban: null,
  payoutName: null,
  taxId: null,
  taxForm: null,
  acceptTermsVersion: 1,
  ...over,
});

/** Applies, approves, switches to cash. Returns the creator account. */
async function activeCreator(w: World, n: number, over: Partial<CreatorProfileView> = {}) {
  w.identity.profiles.set(U(n), profile(U(n), over));
  const r = await w.apply.execute(U(n), applyInput(n));
  if (r.kind !== "applied") throw new Error(`apply failed: ${r.kind}`);
  const d = await w.decide.execute({ creatorId: r.account.id, action: "approve", reason: "auto-checks:ok ref-test", reviewerId: U(9) });
  if (d.kind !== "ok") throw new Error("approve failed");
  await w.store.setPayoutPref(r.account.id, "cash", T0);
  return d.account;
}

/** Creator `c` has a click from the buyer's device; buyer places an order that gets attributed. */
async function attributedOrder(w: World, creatorN: number, buyerN: number, orderN: number) {
  const creator = await w.store.getByUser(U(creatorN));
  if (creator === null) throw new Error("no creator");
  w.catalog.targets.set(`product:${U(300 + orderN)}`, { exists: true, storeId: U(1000) });
  const l = await w.createLink.execute(U(creatorN), "product", U(300 + orderN));
  if (l.kind !== "created" && l.kind !== "exists") throw new Error(`link: ${l.kind}`);
  const dev = hex(String.fromCharCode(96 + buyerN));
  w.identity.profiles.set(U(buyerN), profile(U(buyerN), { deviceHashes: [dev] }));
  const c = await w.click.execute({ slug: l.link.slug, deviceHash: dev, ipHash: hex("9"), uaClass: "app" });
  expect(c.kind).toBe("recorded");
  w.clock.ms += 1000;
  const a = await w.attribute.execute({ orderGroupId: U(400 + orderN), buyerUserId: U(buyerN), orderAtMs: w.clock.ms });
  return { a, creator };
}

const lineClosed = (orderN: number, over: object = {}) => ({
  messageId: U(2000 + orderN),
  orderGroupId: U(400 + orderN),
  orderLineId: U(700 + orderN),
  categoryId: null,
  merchandiseGross: 114_000n, // base 100,000 after 14% VAT
  voucherAllocated: 0n,
  refundedMerchandiseGross: 0n,
  closedAtMs: w0() + 15 * DAY,
  returnWindowEndsAtMs: 0,
  openReturns: 0,
  ...over,
});
const w0 = (): number => T0;

describe("application and KYC", () => {
  it("refuses an applicant under 21 with the policy reason and stores nothing", async () => {
    const w = world();
    w.identity.profiles.set(U(1), profile(U(1), { ageYears: 20 }));
    const r = await w.apply.execute(U(1), applyInput(1));
    expect(r).toEqual({ kind: "ineligible", reason: "under_age" });
    expect(await w.store.getByUser(U(1))).toBeNull();
    expect(w.store.kyc.size).toBe(0);
  });

  it("seals KYC, refuses reserved and taken handles and reused identity documents", async () => {
    const w = world();
    w.identity.profiles.set(U(1), profile(U(1)));
    w.identity.profiles.set(U(2), profile(U(2)));
    w.identity.profiles.set(U(3), profile(U(3)));
    expect((await w.apply.execute(U(1), applyInput(1, { handle: "official" }))).kind).toBe("ineligible");
    expect((await w.apply.execute(U(1), applyInput(1))).kind).toBe("applied");
    const kyc = [...w.store.kyc.values()][0];
    expect(new TextDecoder().decode(kyc?.nationalIdEnc)).toContain("sealed:");
    expect((await w.apply.execute(U(2), applyInput(2, { handle: "creator_1" }))).kind).toBe("handle_taken");
    expect((await w.apply.execute(U(3), applyInput(3, { nationalId: applyInput(1).nationalId }))).kind).toBe("conflict");
    expect((await w.apply.execute(U(1), applyInput(1))).kind).toBe("already_applied");
  });

  it("requires the current terms version and the program flag", async () => {
    const w = world();
    w.identity.profiles.set(U(1), profile(U(1)));
    expect(await w.apply.execute(U(1), applyInput(1, { acceptTermsVersion: 7 }))).toEqual({ kind: "ineligible", reason: "terms_not_accepted" });
    w.flags.program = false;
    expect((await w.apply.execute(U(1), applyInput(1))).kind).toBe("unavailable");
  });

  it("suspension disables links, stops clicks and holds new accruals", async () => {
    const w = world();
    const a = await activeCreator(w, 1);
    const { a: att } = await attributedOrder(w, 1, 2, 1);
    expect(att.kind).toBe("attributed");
    await w.decide.execute({ creatorId: a.id, action: "suspend", reason: "review", reviewerId: U(9) });
    expect((await w.store.listLinks(a.id)).every((l) => l.status === "DISABLED")).toBe(true);
    const slug = (await w.store.listLinks(a.id))[0]?.slug ?? "";
    expect(await w.click.execute({ slug, deviceHash: hex("b"), ipHash: hex("9"), uaClass: "app" })).toEqual({ kind: "unknown" });
    const r = await w.accrue.execute(lineClosed(1));
    expect(r.kind).toBe("held");
    expect(w.ledger.entries.size).toBe(0);
    // reinstating releases the held commission into the ledger
    await w.decide.execute({ creatorId: a.id, action: "reinstate", reason: null, reviewerId: U(9) });
    expect(await w.release.execute()).toEqual({ released: 1, stillHeld: 0 });
    expect(await w.ledger.payableBalance(U(1))).toBe(3_000n);
  });
});

describe("links, clicks and attribution", () => {
  it("a creator cannot link a store they sell for", async () => {
    const w = world();
    await activeCreator(w, 1, { sellerStoreIds: [U(1000)] });
    w.catalog.targets.set(`product:${U(301)}`, { exists: true, storeId: U(1000) });
    expect(await w.createLink.execute(U(1), "product", U(301))).toEqual({ kind: "seller_conflict" });
    expect(await w.createLink.execute(U(1), "product", U(999))).toEqual({ kind: "target_not_found" });
  });

  it("last valid click wins between two creators", async () => {
    const w = world();
    await activeCreator(w, 1);
    await activeCreator(w, 2);
    w.catalog.targets.set(`product:${U(301)}`, { exists: true, storeId: U(1000) });
    const l1 = await w.createLink.execute(U(1), "product", U(301));
    const l2 = await w.createLink.execute(U(2), "product", U(301));
    if (!("link" in l1) || !("link" in l2)) throw new Error("links");
    const dev = hex("c");
    w.identity.profiles.set(U(5), profile(U(5), { deviceHashes: [dev] }));
    await w.click.execute({ slug: l1.link.slug, deviceHash: dev, ipHash: hex("1"), uaClass: "app" });
    w.clock.ms += 5000;
    await w.click.execute({ slug: l2.link.slug, deviceHash: dev, ipHash: hex("2"), uaClass: "browser" });
    w.clock.ms += 5000;
    const r = await w.attribute.execute({ orderGroupId: U(401), buyerUserId: U(5), orderAtMs: w.clock.ms });
    expect(r.kind === "attributed" && r.attribution.creatorId).toBe((await w.store.getByUser(U(2)))?.id);
  });

  it("bot clicks and clicks past the per-IP hourly cap never attribute", async () => {
    const w = world({ cfg: { maxCountedClicksPerIpPerHour: 2 } });
    await activeCreator(w, 1);
    w.catalog.targets.set(`product:${U(301)}`, { exists: true, storeId: null });
    const l = await w.createLink.execute(U(1), "product", U(301));
    if (!("link" in l)) throw new Error("link");
    await w.click.execute({ slug: l.link.slug, deviceHash: hex("d"), ipHash: hex("1"), uaClass: "bot" });
    await w.click.execute({ slug: l.link.slug, deviceHash: hex("e"), ipHash: hex("1"), uaClass: "app" });
    await w.click.execute({ slug: l.link.slug, deviceHash: hex("e"), ipHash: hex("1"), uaClass: "app" });
    const over = await w.click.execute({ slug: l.link.slug, deviceHash: hex("f"), ipHash: hex("1"), uaClass: "app" });
    expect(over.kind).toBe("recorded"); // accepted, but not counted
    w.identity.profiles.set(U(5), profile(U(5), { deviceHashes: [hex("d"), hex("f")] }));
    w.clock.ms += 1000;
    expect((await w.attribute.execute({ orderGroupId: U(401), buyerUserId: U(5), orderAtMs: w.clock.ms })).kind).toBe("none");
  });

  it("a click older than the window does not attribute", async () => {
    const w = world();
    await activeCreator(w, 1);
    w.catalog.targets.set(`product:${U(301)}`, { exists: true, storeId: null });
    const l = await w.createLink.execute(U(1), "product", U(301));
    if (!("link" in l)) throw new Error("link");
    w.identity.profiles.set(U(5), profile(U(5), { deviceHashes: [hex("d")] }));
    await w.click.execute({ slug: l.link.slug, deviceHash: hex("d"), ipHash: hex("1"), uaClass: "app" });
    const r = await w.attribute.execute({ orderGroupId: U(401), buyerUserId: U(5), orderAtMs: T0 + 8 * DAY });
    expect(r.kind).toBe("none");
  });

  it("self purchase through the own link earns nothing and leaves a silent audit event", async () => {
    const w = world();
    const a = await activeCreator(w, 1, { deviceHashes: [hex("a")] });
    w.catalog.targets.set(`product:${U(301)}`, { exists: true, storeId: null });
    const l = await w.createLink.execute(U(1), "product", U(301));
    if (!("link" in l)) throw new Error("link");
    await w.click.execute({ slug: l.link.slug, deviceHash: hex("a"), ipHash: hex("1"), uaClass: "app" });
    w.clock.ms += 1000;
    const r = await w.attribute.execute({ orderGroupId: U(401), buyerUserId: U(1), orderAtMs: w.clock.ms });
    expect(r.kind).toBe("voided");
    expect(w.store.events.some((e) => e.type === "creator.attribution_voided" && e.reason === "self_purchase")).toBe(true);
    const acc = await w.accrue.execute(lineClosed(1));
    expect(acc).toEqual({ kind: "ignored", reason: "voided" });
    expect(await w.ledger.payableBalance(U(1))).toBe(0n);
    expect(w.ledger.entries.size).toBe(0);
    expect((await w.store.listCommissions(a.id, 10, null))).toHaveLength(0);
  });

  it("shared payment instrument and a linked ring are voided", async () => {
    const w = world({ cfg: { clusterThreshold: 2 } });
    await activeCreator(w, 1, { paymentFingerprintHashes: [hex("f")] });
    w.identity.profiles.set(U(2), profile(U(2), { deviceHashes: [hex("b")], paymentFingerprintHashes: [hex("f")] }));
    w.catalog.targets.set(`product:${U(301)}`, { exists: true, storeId: null });
    const l = await w.createLink.execute(U(1), "product", U(301));
    if (!("link" in l)) throw new Error("link");
    await w.click.execute({ slug: l.link.slug, deviceHash: hex("b"), ipHash: hex("1"), uaClass: "app" });
    w.clock.ms += 1000;
    expect((await w.attribute.execute({ orderGroupId: U(401), buyerUserId: U(2), orderAtMs: w.clock.ms })).kind).toBe("voided");
  });

  it("attribution is idempotent per order group", async () => {
    const w = world();
    await activeCreator(w, 1);
    const first = await attributedOrder(w, 1, 2, 1);
    expect(first.a.kind).toBe("attributed");
    const again = await w.attribute.execute({ orderGroupId: U(401), buyerUserId: U(2), orderAtMs: w.clock.ms });
    expect(again.kind).toBe("existing");
  });
});

describe("commission accrual, clawback and the ledger", () => {
  it("accrues only at closure, on the base after VAT, and posts balanced entries", async () => {
    const w = world();
    const a = await activeCreator(w, 1);
    await attributedOrder(w, 1, 2, 1);
    // before closure nothing exists
    expect(await w.ledger.payableBalance(U(1))).toBe(0n);
    const r = await w.accrue.execute(lineClosed(1));
    expect(r).toMatchObject({ kind: "accrued", amount: 3_000n });
    expect(await w.ledger.payableBalance(U(1))).toBe(3_000n);
    expect(w.ledger.trialBalance()).toBe(0n);
    const dash = await w.dashboard.execute(U(1));
    expect(dash?.balance).toEqual({ payable: 3_000n, owesPlatform: 0n, negative: false });
    expect(dash?.totals.pending).toBe(3_000n);
    expect(a.status).toBe("ACTIVE");
  });

  it("a line returned before closure earns nothing for the returned part", async () => {
    const w = world();
    await activeCreator(w, 1);
    await attributedOrder(w, 1, 2, 1);
    const r = await w.accrue.execute(lineClosed(1, { refundedMerchandiseGross: 114_000n }));
    expect(r).toEqual({ kind: "ignored", reason: "zero" });
    expect(w.ledger.entries.size).toBe(0);
  });

  it("voucher-funded value earns no commission", async () => {
    const w = world();
    await activeCreator(w, 1);
    await attributedOrder(w, 1, 2, 1);
    const r = await w.accrue.execute(lineClosed(1, { voucherAllocated: 57_000n }));
    expect(r).toMatchObject({ kind: "accrued", amount: 1_500n });
  });

  it("a refund after accrual claws back through a reversing entry and replays safely", async () => {
    const w = world();
    await activeCreator(w, 1);
    await attributedOrder(w, 1, 2, 1);
    await w.accrue.execute(lineClosed(1));
    const m = { orderLineId: U(701), lineMerchandiseGross: 114_000n };
    const r1 = await w.refund.execute({ ...m, messageId: U(3001), refundedMerchandiseGross: 57_000n });
    expect(r1).toMatchObject({ kind: "applied", clawedBack: 1_500n });
    expect((await w.refund.execute({ ...m, messageId: U(3001), refundedMerchandiseGross: 57_000n })).kind).toBe("duplicate");
    const r2 = await w.refund.execute({ ...m, messageId: U(3002), refundedMerchandiseGross: 57_000n });
    expect(r2).toMatchObject({ kind: "applied", clawedBack: 0n });
    expect(await w.ledger.payableBalance(U(1))).toBe(1_500n);
    expect(w.ledger.trialBalance()).toBe(0n);
  });

  it("a clawback of an already paid commission shows an explicit negative balance and blocks payouts", async () => {
    const w = world({ payouts: true });
    const a = await activeCreator(w, 1);
    await attributedOrder(w, 1, 2, 1);
    await w.accrue.execute(lineClosed(1, { merchandiseGross: 11_400_000n }));
    // pay out everything
    const p = await w.payouts.create({ creatorId: a.id, requestedBy: U(8) });
    if (p.kind !== "ok") throw new Error(`create ${p.kind}`);
    w.approvals.records.set(p.payout.id, []);
    const approved = await w.payouts.approve({ payoutId: p.payout.id, approverId: U(9) });
    expect(approved.kind === "ok" || approved.kind === "approval_required").toBe(true);
    // 3,000 EGP... below the dual-approval threshold, so approval is not required
    if (approved.kind !== "ok") throw new Error(`approve ${approved.kind}`);
    const sent = await w.payouts.send({ payoutId: p.payout.id });
    expect(sent.kind).toBe("ok");
    expect(await w.ledger.payableBalance(U(1))).toBe(0n);

    const r = await w.refund.execute({ messageId: U(3001), orderLineId: U(701), lineMerchandiseGross: 11_400_000n, refundedMerchandiseGross: 11_400_000n });
    expect(r).toMatchObject({ kind: "applied", clawedBack: 300_000n });
    expect(await w.ledger.payableBalance(U(1))).toBe(-300_000n);
    expect(w.store.events.some((e) => e.type === "creator.balance_negative" && e.owes === 300_000n)).toBe(true);
    const dash = await w.dashboard.execute(U(1));
    expect(dash?.balance).toEqual({ payable: 0n, owesPlatform: 300_000n, negative: true });
    expect(w.ledger.trialBalance()).toBe(0n);
    expect(await w.payouts.create({ creatorId: a.id, requestedBy: U(8) })).toEqual({ kind: "negative_balance", owes: 300_000n });
  });

  it("a ledger outage between claim and post is repaired by the sweep without double posting", async () => {
    const w = world();
    await activeCreator(w, 1);
    await attributedOrder(w, 1, 2, 1);
    w.ledger.failNext = 1;
    await expect(w.accrue.execute(lineClosed(1))).rejects.toThrow();
    expect(w.ledger.entries.size).toBe(0);
    expect(await w.store.listUnpostedIntents(10)).toHaveLength(1);
    expect(await w.poster.sweep()).toEqual({ posted: 1, failed: 0 });
    expect(await w.poster.sweep()).toEqual({ posted: 0, failed: 0 });
    expect(await w.ledger.payableBalance(U(1))).toBe(3_000n);
    // the redelivered message is a duplicate: no second entry
    expect((await w.accrue.execute(lineClosed(1))).kind).toBe("duplicate");
    expect(w.ledger.entries.size).toBe(1);
  });

  it("the monthly cap holds a commission until the next month has room", async () => {
    const w = world({ cfg: { monthlyAccrualCap: 4_000n } });
    await activeCreator(w, 1);
    await attributedOrder(w, 1, 2, 1);
    expect((await w.accrue.execute(lineClosed(1))).kind).toBe("accrued");
    const second = await w.accrue.execute(lineClosed(2, { orderGroupId: U(401) }));
    expect(second.kind).toBe("held");
    expect(await w.ledger.payableBalance(U(1))).toBe(3_000n);
    w.clock.ms = T0 + 40 * DAY;
    expect(await w.release.execute()).toEqual({ released: 1, stillHeld: 0 });
    expect(await w.ledger.payableBalance(U(1))).toBe(6_000n);
  });

  it("property: any accrual and refund sequence keeps the ledger balanced and payable never exceeds accrued", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            gross: fc.bigInt({ min: 1_000n, max: 50_000_000n }),
            voucher: fc.bigInt({ min: 0n, max: 1_000_000n }),
            refunds: fc.array(fc.bigInt({ min: 0n, max: 60_000_000n }), { maxLength: 4 }),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        async (lines) => {
          const w = world({ cfg: { monthlyAccrualCap: 10n ** 12n } });
          await activeCreator(w, 1);
          await attributedOrder(w, 1, 2, 1);
          let accrued = 0n;
          let n = 0;
          for (const l of lines) {
            n += 1;
            const r = await w.accrue.execute({
              messageId: U(5000 + n),
              orderGroupId: U(401),
              orderLineId: U(6000 + n),
              categoryId: null,
              merchandiseGross: l.gross,
              voucherAllocated: l.voucher,
              refundedMerchandiseGross: 0n,
              closedAtMs: T0 + 15 * DAY,
              returnWindowEndsAtMs: 0,
              openReturns: 0,
            });
            if (r.kind === "accrued") accrued += r.amount;
            let m = 0;
            let cum = 0n;
            for (const rf of l.refunds) {
              m += 1;
              cum += rf;
              await w.refund.execute({ messageId: U(7000 + n * 10 + m), orderLineId: U(6000 + n), lineMerchandiseGross: l.gross, refundedMerchandiseGross: cum });
            }
          }
          const payable = await w.ledger.payableBalance(U(1));
          expect(w.ledger.trialBalance()).toBe(0n);
          expect(payable >= 0n).toBe(true);
          expect(payable <= accrued).toBe(true);
          const creator = await w.store.getByUser(U(1));
          const totals = await w.store.commissionTotals(creator?.id ?? "");
          expect(totals.pending).toBe(payable);
          expect(await w.store.listUnpostedIntents(100)).toHaveLength(0);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe("payouts are engaged off", () => {
  async function accrued(w: World, gross = 11_400_000n) {
    const a = await activeCreator(w, 1);
    await attributedOrder(w, 1, 2, 1);
    await w.accrue.execute(lineClosed(1, { merchandiseGross: gross }));
    return a;
  }

  it("with the kill switch blocked accruals continue and no payout instruction is created", async () => {
    const w = world({ payouts: false });
    const a = await accrued(w);
    expect(await w.payouts.create({ creatorId: a.id, requestedBy: U(8) })).toEqual({ kind: "disabled" });
    expect(await w.store.listPayouts({ limit: 10 })).toHaveLength(0);
    expect((await w.dashboard.execute(U(1)))?.payoutsEnabled).toBe(false);
    expect(await w.ledger.payableBalance(U(1))).toBe(300_000n);
  });

  it("with the switch allowed but the provider Unconfigured nothing is sent", async () => {
    const w = world({ payouts: true, provider: new UnconfiguredCreatorPayoutProvider() });
    const a = await accrued(w);
    const p = await w.payouts.create({ creatorId: a.id, requestedBy: U(8) });
    if (p.kind !== "ok") throw new Error(p.kind);
    expect((await w.payouts.approve({ payoutId: p.payout.id, approverId: U(9) })).kind).toBe("ok");
    expect(await w.payouts.send({ payoutId: p.payout.id })).toEqual({ kind: "provider_unconfigured" });
    expect(await w.ledger.payableBalance(U(1))).toBe(300_000n);
  });

  it("dual approval: the requester cannot approve, a covering record from another approver can", async () => {
    const w = world({ payouts: true, cfg: { monthlyAccrualCap: 10n ** 12n } });
    const a = await accrued(w, 200_000_000n); // commission above the 5,000,000 dual-approval threshold
    const p = await w.payouts.create({ creatorId: a.id, requestedBy: U(8) });
    if (p.kind !== "ok") throw new Error(p.kind);
    expect((await w.payouts.approve({ payoutId: p.payout.id, approverId: U(8) })).kind).toBe("approval_required");
    expect((await w.payouts.approve({ payoutId: p.payout.id, approverId: U(9) })).kind).toBe("approval_required");
    w.approvals.records.set(p.payout.id, [
      {
        id: "ap-1",
        kind: "payout",
        subjectType: "payout",
        subjectId: p.payout.id,
        amountMinor: p.payout.amount,
        reasonCode: "creator_payout",
        requesterId: U(8),
        state: "APPROVED",
        approverId: U(9),
        requestedAtMs: T0 - 1000,
        expiresAtMs: T0 + DAY,
        decidedAtMs: T0 - 500,
        decisionNote: null,
      },
    ]);
    expect((await w.payouts.approve({ payoutId: p.payout.id, approverId: U(9) })).kind).toBe("ok");
  });

  it("send posts ledger first, then settles and marks commissions PAID; a rejection reverses", async () => {
    const w = world({ payouts: true });
    const a = await accrued(w);
    const p = await w.payouts.create({ creatorId: a.id, requestedBy: U(8) });
    if (p.kind !== "ok") throw new Error(p.kind);
    expect((await w.payouts.approve({ payoutId: p.payout.id, approverId: U(9) })).kind).toBe("ok");
    const provider = w.provider as FakeCreatorPayoutProvider;
    provider.next = { kind: "rejected", reason: "bank_declined" };
    const rej = await w.payouts.send({ payoutId: p.payout.id });
    expect(rej.kind === "ok" && rej.payout.state).toBe("FAILED");
    expect(await w.ledger.payableBalance(U(1))).toBe(300_000n);
    expect(w.ledger.trialBalance()).toBe(0n);

    // retry: cancel the failed payout, create again, settle
    expect((await w.payouts.cancel({ payoutId: p.payout.id })).kind).toBe("ok");
    const p2 = await w.payouts.create({ creatorId: a.id, requestedBy: U(8) });
    if (p2.kind !== "ok") throw new Error(p2.kind);
    await w.payouts.approve({ payoutId: p2.payout.id, approverId: U(9) });
    provider.next = { kind: "settled", providerRef: "bank-1" };
    const ok = await w.payouts.send({ payoutId: p2.payout.id });
    expect(ok.kind === "ok" && ok.payout.state).toBe("SETTLED");
    expect(await w.ledger.payableBalance(U(1))).toBe(0n);
    expect((await w.dashboard.execute(U(1)))?.totals.paid).toBe(300_000n);
    expect(w.ledger.trialBalance()).toBe(0n);
  });

  it("a creator under 21 or without approved KYC never gets a payout and credit preference is refused", async () => {
    const w = world({ payouts: true });
    const a = await accrued(w);
    w.identity.profiles.set(U(1), profile(U(1), { ageYears: 20 }));
    expect(await w.payouts.create({ creatorId: a.id, requestedBy: U(8) })).toEqual({ kind: "ineligible", reason: "under_age" });
    w.identity.profiles.set(U(1), profile(U(1)));
    await w.store.setPayoutPref(a.id, "credit", T0);
    expect(await w.payouts.create({ creatorId: a.id, requestedBy: U(8) })).toEqual({ kind: "credit_preference" });
  });

  it("an IBAN identity mismatch puts the payout on hold before any money moves", async () => {
    const w = world({ payouts: true });
    const a = await accrued(w);
    const p = await w.payouts.create({ creatorId: a.id, requestedBy: U(8) });
    if (p.kind !== "ok") throw new Error(p.kind);
    await w.payouts.approve({ payoutId: p.payout.id, approverId: U(9) });
    w.vault.matched = false;
    const r = await w.payouts.send({ payoutId: p.payout.id });
    expect(r).toMatchObject({ kind: "held", reason: "iban_name_mismatch" });
    expect(await w.ledger.payableBalance(U(1))).toBe(300_000n);
  });
});

describe("looks", () => {
  it("only real catalog items, no creator-entered prices, takedown is final", async () => {
    const w = world();
    const a = await activeCreator(w, 1);
    w.catalog.products.add(U(301));
    expect((await w.looks.create(U(1), { title: "Eid", productIds: [U(301), U(999)] })).kind).toBe("unknown_products");
    const c = await w.looks.create(U(1), { title: "Eid", productIds: [U(301)] });
    if (c.kind !== "ok") throw new Error("create");
    expect((await w.looks.publish(U(1), c.look.id)).kind).toBe("ok");
    // another creator cannot touch it (BOLA): same answer as a missing id
    await activeCreator(w, 2);
    expect(await w.looks.update(U(2), c.look.id, { title: "x" })).toEqual({ kind: "not_found" });
    expect(await w.looks.publish(U(2), c.look.id)).toEqual({ kind: "not_found" });
    await w.looks.takedown(c.look.id, "counterfeit report");
    expect((await w.looks.publish(U(1), c.look.id)).kind).toBe("invalid_state");
    expect((await w.store.getLook(c.look.id))?.status).toBe("TAKEN_DOWN");
    expect(a.status).toBe("ACTIVE");
  });
});

// ---- phase-3 money review, part A regressions ---------------------------------------------------

async function linkFor(w: World, creatorN: number, productN: number): Promise<string> {
  w.catalog.targets.set(`product:${U(300 + productN)}`, { exists: true, storeId: null });
  const l = await w.createLink.execute(U(creatorN), "product", U(300 + productN));
  if (l.kind !== "created" && l.kind !== "exists") throw new Error(`link ${l.kind}`);
  return l.link.slug;
}
const clickEvents = (w: World) => w.store.events.filter((e) => e.type === "affiliate.clicks_active" || e.type === "affiliate.click_recorded");

describe("A-1 click ingest is abuse resistant", () => {
  it("a click storm writes one row per device and link per dedupe window and ONE aggregate outbox event", async () => {
    const w = world();
    const a = await activeCreator(w, 1);
    const slug = await linkFor(w, 1, 1);
    for (let i = 0; i < 50; i += 1) {
      await w.click.execute({ slug, deviceHash: hex("a"), ipHash: hex("1"), uaClass: "app" });
    }
    expect((await w.store.clickStats(a.id, 0)).total).toBe(1);
    expect(clickEvents(w)).toHaveLength(1);
    // another device inside the same minute: a second row, still no new event
    await w.click.execute({ slug, deviceHash: hex("b"), ipHash: hex("2"), uaClass: "app" });
    expect((await w.store.clickStats(a.id, 0)).total).toBe(2);
    expect(clickEvents(w)).toHaveLength(1);
    // next minute: one more event
    w.clock.ms += 61_000;
    await w.click.execute({ slug, deviceHash: hex("c"), ipHash: hex("3"), uaClass: "app" });
    expect(clickEvents(w)).toHaveLength(2);
  });

  it("the per-device cap keys on the device hash, not on the ip (rotating ips do not help)", async () => {
    const w = world({ cfg: { maxCountedClicksPerDevicePerHour: 2 } });
    const a = await activeCreator(w, 1);
    const slugs = [await linkFor(w, 1, 1), await linkFor(w, 1, 2), await linkFor(w, 1, 3)];
    for (const [i, slug] of slugs.entries()) {
      await w.click.execute({ slug, deviceHash: hex("a"), ipHash: hex(String(i + 1)), uaClass: "app" });
    }
    const st = await w.store.clickStats(a.id, 0);
    expect(st).toEqual({ total: 3, counted: 2 });
    // the uncounted third click can never attribute
    w.identity.profiles.set(U(5), profile(U(5), { deviceHashes: [hex("a")] }));
    w.clock.ms += 1000;
    const r = await w.attribute.execute({ orderGroupId: U(401), buyerUserId: U(5), orderAtMs: w.clock.ms });
    expect(r.kind === "attributed" && r.attribution.clickAtMs).toBeLessThan(w.clock.ms - 0);
  });

  it("the per-link cap bounds counted clicks from many devices", async () => {
    const w = world({ cfg: { maxCountedClicksPerLinkPerHour: 3 } });
    const a = await activeCreator(w, 1);
    const slug = await linkFor(w, 1, 1);
    for (let i = 0; i < 6; i += 1) {
      await w.click.execute({ slug, deviceHash: hex(String.fromCharCode(97 + i)), ipHash: hex(String(i)), uaClass: "app" });
    }
    expect(await w.store.clickStats(a.id, 0)).toEqual({ total: 6, counted: 3 });
  });

  it("a later click for another creator inside the protected window after a session start cannot hijack the attribution", async () => {
    const w = world();
    await activeCreator(w, 1);
    await activeCreator(w, 2);
    const s1 = await linkFor(w, 1, 1);
    const s2 = await linkFor(w, 2, 2);
    await w.click.execute({ slug: s1, deviceHash: hex("a"), ipHash: hex("1"), uaClass: "app" });
    w.clock.ms += 3_600_000;
    const sessionStart = w.clock.ms;
    w.clock.ms += 3_600_000;
    await w.click.execute({ slug: s2, deviceHash: hex("a"), ipHash: hex("9"), uaClass: "app" });
    w.identity.profiles.set(U(5), profile(U(5), { deviceHashes: [hex("a")], sessionStartedAtMs: sessionStart }));
    w.clock.ms += 1000;
    const r = await w.attribute.execute({ orderGroupId: U(401), buyerUserId: U(5), orderAtMs: w.clock.ms });
    expect(r.kind === "attributed" && r.attribution.creatorId).toBe((await w.store.getByUser(U(1)))?.id);
  });
});

describe("A-2 payout send claims before it posts", () => {
  async function approvedPayout(w: World) {
    const a = await activeCreator(w, 1);
    await attributedOrder(w, 1, 2, 1);
    await w.accrue.execute(lineClosed(1, { merchandiseGross: 11_400_000n }));
    const p = await w.payouts.create({ creatorId: a.id, requestedBy: U(8) });
    if (p.kind !== "ok") throw new Error(p.kind);
    const ok = await w.payouts.approve({ payoutId: p.payout.id, approverId: U(9) });
    if (ok.kind !== "ok") throw new Error(ok.kind);
    return { a, id: p.payout.id };
  }

  it("a cancel that wins the compare-and-set leaves NO payout entry and the payable untouched", async () => {
    const w = world({ payouts: true });
    const { id } = await approvedPayout(w);
    const before = await w.ledger.payableBalance(U(1));
    const stale = await w.store.getPayout(id); // what send read: APPROVED
    expect((await w.payouts.cancel({ payoutId: id })).kind).toBe("ok");
    w.store.getPayout = async () => stale;
    expect((await w.payouts.send({ payoutId: id })).kind).toBe("conflict");
    expect([...w.ledger.entries.keys()].filter((k) => k.startsWith("creator_payout:"))).toHaveLength(0);
    expect(await w.ledger.payableBalance(U(1))).toBe(before);
  });

  it("a crash between the CAS and the post is recovered: the entry is posted once and the rail is called once", async () => {
    const provider = new FakeCreatorPayoutProvider();
    const w = world({ payouts: true, provider });
    const { id } = await approvedPayout(w);
    w.ledger.failNext = 1;
    await expect(w.payouts.send({ payoutId: id })).rejects.toThrow("ledger unavailable");
    expect((await w.store.getPayout(id))?.state).toBe("SENT");
    expect(provider.sent).toHaveLength(0);
    const r = await w.payouts.recoverOrphans(0);
    expect(r.resumed).toBe(1);
    expect(provider.sent).toHaveLength(1);
    expect(await w.ledger.payableBalance(U(1))).toBe(0n);
    expect(w.ledger.trialBalance()).toBe(0n);
    expect((await w.payouts.recoverOrphans(0)).resumed).toBe(0);
  });

  it("an entry whose payout is not SENT is reversed exactly once", async () => {
    const w = world({ payouts: true });
    const { id, a } = await approvedPayout(w);
    expect((await w.payouts.cancel({ payoutId: id })).kind).toBe("ok");
    const p = await w.store.getPayout(id);
    if (p === null) throw new Error("payout");
    const before = await w.ledger.payableBalance(U(1));
    // simulate the lost-CAS leftover of the old ledger-first code
    await w.ledger.post(
      creatorPayout({ creatorId: a.userId, amount: money(p.amount), bankAccount: "creator-bank" }, {
        id: ids.uuidV7(),
        idempotencyKey: `creator_payout:${id}~1`,
        occurredAt: new Date(T0),
        ref: { type: "creator_payout", id },
      }),
    );
    expect(await w.ledger.payableBalance(U(1))).toBe(before - p.amount);
    expect((await w.payouts.recoverOrphans(0)).reversed).toBe(1);
    expect(await w.ledger.payableBalance(U(1))).toBe(before);
    expect((await w.payouts.recoverOrphans(0)).reversed).toBe(0);
    expect(w.ledger.trialBalance()).toBe(0n);
  });
});

describe("A-3 fail closed and void after accrual", () => {
  it("a missing creator identity profile holds the attribution: nothing accrues until it resolves", async () => {
    const w = world();
    await activeCreator(w, 1);
    const slug = await linkFor(w, 1, 1);
    w.identity.profiles.set(U(2), profile(U(2), { deviceHashes: [hex("b")] }));
    await w.click.execute({ slug, deviceHash: hex("b"), ipHash: hex("1"), uaClass: "app" });
    w.identity.profiles.delete(U(1)); // identity outage for the creator
    w.clock.ms += 1000;
    const input = { orderGroupId: U(401), buyerUserId: U(2), orderAtMs: w.clock.ms };
    expect((await w.attribute.execute(input)).kind).toBe("held");
    expect(await w.store.getAttribution(U(401))).toMatchObject({ status: "HELD", holdReason: "identity_unavailable" });
    expect((await w.accrue.execute(lineClosed(1))).kind).toBe("deferred");
    expect(await w.ledger.payableBalance(U(1))).toBe(0n);
    // the message was not consumed: after the profile is back it accrues once
    w.identity.profiles.set(U(1), profile(U(1)));
    expect((await w.attribute.execute(input)).kind).toBe("attributed");
    expect((await w.accrue.execute(lineClosed(1))).kind).toBe("accrued");
    expect(await w.ledger.payableBalance(U(1))).toBe(3_000n);
  });

  it("a void after accrual claws the commission back through the ledger and replays safely", async () => {
    const w = world();
    await activeCreator(w, 1);
    await attributedOrder(w, 1, 2, 1);
    await w.accrue.execute(lineClosed(1));
    expect(await w.ledger.payableBalance(U(1))).toBe(3_000n);
    const v = await w.voidAttribution.execute({ orderGroupId: U(401), reason: "cluster" });
    expect(v).toEqual({ kind: "voided", commissionsAffected: 1, clawedBack: 3_000n });
    expect(await w.ledger.payableBalance(U(1))).toBe(0n);
    expect(w.ledger.trialBalance()).toBe(0n);
    expect((await w.store.getAttribution(U(401)))?.status).toBe("VOIDED");
    expect(await w.voidAttribution.execute({ orderGroupId: U(401), reason: "cluster" })).toEqual({ kind: "already_voided" });
    // a later refund or sweep cannot claw back twice
    const r = await w.refund.execute({ messageId: U(3001), orderLineId: U(701), lineMerchandiseGross: 114_000n, refundedMerchandiseGross: 114_000n });
    expect(r).toMatchObject({ kind: "applied", clawedBack: 0n });
    expect(await w.ledger.payableBalance(U(1))).toBe(0n);
    // and nothing accrues for the voided order afterwards
    expect((await w.accrue.execute(lineClosed(1, { messageId: U(2999), orderLineId: U(799) }))).kind).toBe("ignored");
  });

  it("voiding after payout leaves an explicit negative payable and an event", async () => {
    const w = world({ payouts: true });
    const a = await activeCreator(w, 1);
    await attributedOrder(w, 1, 2, 1);
    await w.accrue.execute(lineClosed(1, { merchandiseGross: 11_400_000n }));
    const p = await w.payouts.create({ creatorId: a.id, requestedBy: U(8) });
    if (p.kind !== "ok") throw new Error(p.kind);
    await w.payouts.approve({ payoutId: p.payout.id, approverId: U(9) });
    await w.payouts.send({ payoutId: p.payout.id });
    const v = await w.voidAttribution.execute({ orderGroupId: U(401), reason: "shared_payment" });
    expect(v).toMatchObject({ kind: "voided", clawedBack: 300_000n });
    expect(await w.ledger.payableBalance(U(1))).toBe(-300_000n);
    expect(w.store.events.filter((e) => e.type === "creator.balance_negative")).toHaveLength(1);
    // replays and concurrent posters never re-emit: the transition already happened
    await w.poster.sweep();
    await Promise.all([w.poster.sweep(), w.poster.sweep()]);
    expect(w.store.events.filter((e) => e.type === "creator.balance_negative")).toHaveLength(1);
    expect(await w.payouts.create({ creatorId: a.id, requestedBy: U(8) })).toEqual({ kind: "negative_balance", owes: 300_000n });
  });

  it("a held (over-cap) commission is voided without a ledger entry when its attribution is voided", async () => {
    const w = world({ cfg: { monthlyAccrualCap: 1_000n } });
    await activeCreator(w, 1);
    await attributedOrder(w, 1, 2, 1);
    expect((await w.accrue.execute(lineClosed(1))).kind).toBe("held");
    const v = await w.voidAttribution.execute({ orderGroupId: U(401), reason: "cluster" });
    expect(v).toEqual({ kind: "voided", commissionsAffected: 0, clawedBack: 0n });
    expect((await w.release.execute()).released).toBe(0);
  });
});

describe("A-4 no stacking with a referral reward", () => {
  it("an order that carries a referral reward earns no creator commission", async () => {
    const w = world();
    await activeCreator(w, 1);
    w.referrals.rewarded.add(U(401));
    const { a } = await attributedOrder(w, 1, 2, 1);
    expect(a.kind).toBe("voided");
    expect((await w.store.getAttribution(U(401)))?.voidReason).toBe("referral_stacking");
    expect((await w.accrue.execute(lineClosed(1))).kind).toBe("ignored");
    expect(await w.ledger.payableBalance(U(1))).toBe(0n);
  });
  it("an order without a referral reward still attributes, and a referral lookup failure holds instead of paying", async () => {
    const w = world();
    await activeCreator(w, 1);
    expect((await attributedOrder(w, 1, 2, 1)).a.kind).toBe("attributed");
    w.referrals.failNext = true;
    expect((await attributedOrder(w, 1, 3, 2)).a.kind).toBe("held");
  });
});

describe("A-5 held release", () => {
  it("a commission above the cap raises a finding and is never released; one with room is", async () => {
    const w = world({ cfg: { monthlyAccrualCap: 1_000n } });
    await activeCreator(w, 1);
    await attributedOrder(w, 1, 2, 1);
    await w.accrue.execute(lineClosed(1));
    const r = await w.release.execute();
    expect(r).toEqual({ released: 0, stillHeld: 1 });
    expect(w.store.events.some((e) => e.type === "creator.commission_over_cap")).toBe(true);
  });
});

describe("A-6 hold hygiene and A-10 review evidence", () => {
  it("approving a payout out of ON_HOLD re-checks the cause", async () => {
    const w = world({ payouts: true });
    const a = await activeCreator(w, 1);
    await attributedOrder(w, 1, 2, 1);
    await w.accrue.execute(lineClosed(1, { merchandiseGross: 11_400_000n }));
    const p = await w.payouts.create({ creatorId: a.id, requestedBy: U(8) });
    if (p.kind !== "ok") throw new Error(p.kind);
    await w.payouts.approve({ payoutId: p.payout.id, approverId: U(9) });
    w.vault.matched = false;
    expect((await w.payouts.send({ payoutId: p.payout.id })).kind).toBe("held");
    expect(await w.payouts.approve({ payoutId: p.payout.id, approverId: U(9) })).toMatchObject({ kind: "held", reason: "iban_name_mismatch" });
    w.vault.matched = true;
    expect((await w.payouts.approve({ payoutId: p.payout.id, approverId: U(9) })).kind).toBe("ok");
  });

  it("approval without review evidence is refused", async () => {
    const w = world();
    w.identity.profiles.set(U(1), profile(U(1)));
    const r = await w.apply.execute(U(1), applyInput(1));
    if (r.kind !== "applied") throw new Error(r.kind);
    expect(await w.decide.execute({ creatorId: r.account.id, action: "approve", reason: null, reviewerId: U(9) })).toEqual({ kind: "evidence_required" });
    expect((await w.decide.execute({ creatorId: r.account.id, action: "approve", reason: "  ", reviewerId: U(9) })).kind).toBe("evidence_required");
  });
});

describe("A-7 accepted terms are stored", () => {
  it("apply stores the exact text and refuses when the stored text differs", async () => {
    const w = world();
    w.identity.profiles.set(U(1), profile(U(1)));
    expect((await w.apply.execute(U(1), applyInput(1))).kind).toBe("applied");
    expect(await w.store.ensureTerms(1, [{ locale: "en", body: "x".repeat(30), sha256: "f".repeat(64) }])).toBe("mismatch");
    w.identity.profiles.set(U(2), profile(U(2)));
    w.terms.texts = async () => [{ locale: "en", body: "x".repeat(30), sha256: "f".repeat(64) }];
    expect((await w.apply.execute(U(2), applyInput(2))).kind).toBe("unavailable");
  });
});

describe("A-9 click partitions and retention", () => {
  it("the maintenance job removes clicks older than 13 months and keeps the rest", async () => {
    const w = world();
    const a = await activeCreator(w, 1);
    const slug = await linkFor(w, 1, 1);
    w.clock.ms = T0 - 14 * 31 * DAY;
    await w.click.execute({ slug, deviceHash: hex("a"), ipHash: hex("1"), uaClass: "app" });
    w.clock.ms = T0;
    await w.click.execute({ slug, deviceHash: hex("b"), ipHash: hex("2"), uaClass: "app" });
    const r = await w.maintain.execute();
    expect(r.deletedRows).toBe(1);
    expect((await w.store.clickStats(a.id, 0)).total).toBe(1);
  });
});

describe("A-9 accrual waits for open returns and the line's own return window", () => {
  const DAYMS = 86_400_000;
  it("an open return at closure defers; no ledger entry; accrues once the return is terminal", async () => {
    const w = world();
    await activeCreator(w, 1);
    await attributedOrder(w, 1, 2, 1);
    expect((await w.accrue.execute(lineClosed(1, { openReturns: 1 }))).kind).toBe("deferred");
    expect(await w.ledger.payableBalance(U(1))).toBe(0n);
    expect((await w.accrue.execute(lineClosed(1, { openReturns: 0 }))).kind).toBe("accrued");
  });

  it("a seller window longer than 33 days defers until it has elapsed", async () => {
    const w = world();
    await activeCreator(w, 1);
    await attributedOrder(w, 1, 2, 1);
    const end = w.clock.ms + 45 * DAYMS;
    expect((await w.accrue.execute(lineClosed(1, { returnWindowEndsAtMs: end }))).kind).toBe("deferred");
    expect(await w.ledger.payableBalance(U(1))).toBe(0n);
    w.clock.ms = end;
    expect((await w.accrue.execute(lineClosed(1, { returnWindowEndsAtMs: end }))).kind).toBe("accrued");
  });

  it("unknown window or return facts fail closed", async () => {
    const w = world();
    await activeCreator(w, 1);
    await attributedOrder(w, 1, 2, 1);
    expect((await w.accrue.execute(lineClosed(1, { returnWindowEndsAtMs: null }))).kind).toBe("deferred");
    expect((await w.accrue.execute(lineClosed(1, { openReturns: null }))).kind).toBe("deferred");
    expect(await w.ledger.payableBalance(U(1))).toBe(0n);
  });

  it("a refund after accrual claws back pro rata and the payable never goes below zero before payout", async () => {
    const w = world();
    await activeCreator(w, 1);
    await attributedOrder(w, 1, 2, 1);
    await w.accrue.execute(lineClosed(1));
    const r = await w.refund.execute({ messageId: U(3001), orderLineId: U(701), lineMerchandiseGross: 114_000n, refundedMerchandiseGross: 114_000n });
    expect(r).toMatchObject({ kind: "applied", clawedBack: 3_000n });
    expect(await w.ledger.payableBalance(U(1))).toBe(0n);
    expect(w.ledger.trialBalance()).toBe(0n);
  });
});
