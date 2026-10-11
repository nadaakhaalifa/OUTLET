import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { chart } from "../chart-of-accounts";
import { createJournalEntry, type JournalEntry } from "../ledger";
import { money } from "../money";
import { canonicalPayload, samePayload } from "./fingerprint";
import {
  GENESIS_HASH,
  chainPayload,
  nextHash,
  verifyChain,
  type ChainedEntry,
  type Sha256Hex,
} from "./hash-chain";
import {
  buildIntegrityReport,
  checkTrialBalance,
  storeCreditDrift,
  trialBalanceOfEntries,
} from "./integrity";
import { buildReversal } from "./reversal";

const sha: Sha256Hex = (s) => createHash("sha256").update(s).digest("hex");
const E = (n: bigint) => money(n);

function entry(i: number, amount = 1_000n, kind = "test"): JournalEntry {
  return createJournalEntry({
    id: `e${i}`,
    kind,
    idempotencyKey: `k${i}`,
    occurredAt: new Date(1_700_000_000_000 + i),
    ref: { type: "t", id: String(i) },
    postings: [
      { account: chart.pspClearing("p"), amount: E(amount) },
      { account: chart.sellerPayable("A"), amount: E(-amount) },
    ],
  });
}

function chain(entries: JournalEntry[]): ChainedEntry[] {
  let prev = GENESIS_HASH;
  return entries.map((e, i) => {
    const h = nextHash(prev, e, sha);
    const link = { seq: BigInt(i + 1) * 3n, entryId: e.id, prevHash: prev, entryHash: h };
    prev = h;
    return { entry: e, link };
  });
}

describe("fingerprint", () => {
  it("ignores id, time and posting order but not amounts, accounts, kind or reference", () => {
    const a = entry(1);
    const b: JournalEntry = { ...a, id: "other", occurredAt: new Date(0), postings: [...a.postings].reverse() };
    expect(samePayload(a, b)).toBe(true);
    expect(samePayload(a, entry(1, 1_001n))).toBe(false);
    expect(samePayload(a, { ...a, kind: "x" })).toBe(false);
    expect(samePayload(a, { ...a, ref: { type: "t", id: "zzz" } })).toBe(false);
    expect(samePayload(a, { ...a, ref: { type: "u", id: "1" } })).toBe(false);
    expect(canonicalPayload(a)).toContain("psp_clearing:p|1000|EGP");
  });
});

describe("hash chain", () => {
  it("verifies a clean chain and returns the head", () => {
    const items = chain([entry(1), entry(2), entry(3)]);
    const r = verifyChain(items, sha);
    expect(r).toEqual({ ok: true, length: 3, headHash: items[2]?.link.entryHash });
    expect(verifyChain([], sha)).toEqual({ ok: true, length: 0, headHash: GENESIS_HASH });
  });

  it("includes id, time and reversal link in the hash", () => {
    const e = entry(1);
    expect(chainPayload(e)).not.toBe(chainPayload({ ...e, id: "e9" }));
    expect(chainPayload(e)).not.toBe(chainPayload({ ...e, occurredAt: new Date(5) }));
    const r = buildReversal(e, { id: "r1", occurredAt: new Date(1) });
    expect(chainPayload(r)).toContain('"e1"');
  });

  it("pinpoints the first tampered entry, link or ordering", () => {
    const base = [entry(1), entry(2), entry(3)];
    const tamperedEntry = chain(base).map((c, i) => (i === 1 ? { ...c, entry: entry(2, 999n) } : c));
    expect(verifyChain(tamperedEntry, sha)).toMatchObject({ ok: false, entryId: "e2", reason: "entry_hash_mismatch" });

    const removed = chain(base).filter((_, i) => i !== 1);
    expect(verifyChain(removed, sha)).toMatchObject({ ok: false, entryId: "e3", reason: "prev_hash_mismatch" });

    const swapped = chain(base);
    const reordered = [swapped[1], swapped[0], swapped[2]] as ChainedEntry[];
    expect(verifyChain(reordered, sha)).toMatchObject({ ok: false, reason: "prev_hash_mismatch" });

    const wrongEntry = chain(base).map((c, i) => (i === 0 ? { ...c, link: { ...c.link, entryId: "zz" } } : c));
    expect(verifyChain(wrongEntry, sha)).toMatchObject({ ok: false, reason: "entry_mismatch" });

    const seqs = chain(base).map((c, i) => (i === 2 ? { ...c, link: { ...c.link, seq: 3n } } : c));
    expect(verifyChain(seqs, sha)).toMatchObject({ ok: false, entryId: "e3", reason: "sequence_not_increasing" });
  });

  it("verifies a suffix from a known start hash", () => {
    const items = chain([entry(1), entry(2), entry(3)]);
    expect(verifyChain(items.slice(1), sha, items[0]?.link.entryHash).ok).toBe(true);
    expect(verifyChain(items.slice(1), sha).ok).toBe(false);
  });

  it("any single-field mutation of a random chain is detected", () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 1n, max: 1_000_000n }), { minLength: 1, maxLength: 8 }), fc.nat(), (amounts, pick) => {
        const items = chain(amounts.map((a, i) => entry(i + 1, a)));
        expect(verifyChain(items, sha).ok).toBe(true);
        const at = pick % items.length;
        const mutated = items.map((c, i) => (i === at ? { ...c, entry: entry(at + 1, (amounts[at] ?? 1n) + 1n) } : c));
        const r = verifyChain(mutated, sha);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.entryId).toBe(`e${at + 1}`);
      }),
      { numRuns: 100 },
    );
  });
});

describe("trial balance and projection drift", () => {
  it("flags only currencies that do not net to zero", () => {
    expect(checkTrialBalance(new Map([["EGP", 0n]]))).toEqual({ ok: true, offenders: [] });
    expect(checkTrialBalance(new Map([["EGP", 5n], ["USD", 0n]]))).toEqual({
      ok: false,
      offenders: [{ currency: "EGP", total: 5n }],
    });
    expect(trialBalanceOfEntries([entry(1), entry(2)]).ok).toBe(true);
  });

  it("reports drift in both directions, missing sides and negative credit", () => {
    const g = chart.storeCredit("u1", { kind: "gift_card", cardId: "c1" });
    const r = storeCreditDrift(
      [
        { userId: "u1", sub: "goodwill", balance: 500n },
        { userId: "u2", sub: "refund_credit", balance: 100n },
        { userId: "u1", sub: "gift_card:c1", balance: 700n },
      ],
      [
        { account: chart.storeCredit("u1", { kind: "goodwill" }), currency: "EGP", raw: -400n },
        { account: g, currency: "EGP", raw: -700n },
        { account: chart.storeCredit("u3", { kind: "referral_credit" }), currency: "EGP", raw: 50n },
        { account: chart.sellerPayable("A"), currency: "EGP", raw: -9n },
      ],
    );
    expect(r.drift).toEqual([
      { userId: "u1", sub: "goodwill", projected: 500n, fromPostings: 400n, difference: 100n },
      { userId: "u2", sub: "refund_credit", projected: 100n, fromPostings: 0n, difference: 100n },
      { userId: "u3", sub: "referral_credit", projected: 0n, fromPostings: -50n, difference: 50n },
    ]);
    expect(r.negative.map((n) => n.userId)).toEqual(["u3"]);
  });

  it("combines the three checks into one verdict", () => {
    const items = chain([entry(1)]);
    const ok = buildIntegrityReport({
      totals: new Map([["EGP", 0n]]),
      chained: items,
      sha256: sha,
      projection: [],
      accountBalances: [],
    });
    expect(ok.ok).toBe(true);
    const bad = buildIntegrityReport({
      totals: new Map([["EGP", 1n]]),
      chained: items,
      sha256: sha,
      projection: [],
      accountBalances: [],
    });
    expect(bad.ok).toBe(false);
    expect(bad.trialBalance.ok).toBe(false);
    expect(bad.chain.ok).toBe(true);
  });
});
