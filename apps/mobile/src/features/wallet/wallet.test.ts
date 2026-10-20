import { describe, expect, it } from "vitest";
import { resources } from "../../../../../packages/i18n/src/index";
import {
  EMPTY_TRANSACTIONS, InMemoryWalletPort, appendPage, buildWallet, canLoadMore, fixtureTransactions, fixtureWallet, walletFailureState,
  type CreditLot, type WalletSnapshot,
} from "./model";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const lot = (o: Partial<CreditLot> & { id: string }): CreditLot => ({ kind: "goodwill", remaining: 100n, expiresAt: null, last4: null, ...o });

describe("wallet view", () => {
  it("sums sub-balances and shows each with its earliest expiry", () => {
    const s: WalletSnapshot = {
      lots: [
        lot({ id: "a", kind: "goodwill", remaining: 500n, expiresAt: NOW + 5 * DAY }),
        lot({ id: "b", kind: "goodwill", remaining: 300n, expiresAt: NOW + 2 * DAY }),
        lot({ id: "c", kind: "refund_credit", remaining: 1_000n }),
      ],
      expiringSoon: [],
    };
    const v = buildWallet(s);
    expect(v.total).toBe(1_800n);
    expect(v.subs.map((b) => b.kind)).toEqual(["goodwill", "refund_credit"]);
    expect(v.subs[0]?.nextExpiry).toBe(NOW + 2 * DAY);
    expect(v.subs[1]?.neverExpires).toBe(true);
  });
  it("lists refund credit last and drops empty lots", () => {
    const v = buildWallet(fixtureWallet(NOW));
    expect(v.subs[v.subs.length - 1]?.kind).toBe("refund_credit");
    expect(buildWallet({ lots: [lot({ id: "z", remaining: 0n })], expiringSoon: [] }).isEmpty).toBe(true);
  });
  it("uses the server's expiring soon list, soonest first", () => {
    const v = buildWallet({
      lots: [],
      expiringSoon: [lot({ id: "x", expiresAt: NOW + 9 * DAY }), lot({ id: "y", expiresAt: NOW + 3 * DAY })],
    });
    expect(v.expiringSoon.map((l) => l.id)).toEqual(["y", "x"]);
  });
});

describe("transactions with cursor", () => {
  it("pages through and stops when the cursor is null", async () => {
    const port = new InMemoryWalletPort(fixtureWallet(NOW), fixtureTransactions(NOW, 25), null, 10);
    let s = EMPTY_TRANSACTIONS;
    expect(canLoadMore(s)).toBe(false);
    s = appendPage(s, await port.transactions(null));
    expect(s.items).toHaveLength(10);
    expect(canLoadMore(s)).toBe(true);
    s = appendPage(s, await port.transactions(s.nextCursor));
    s = appendPage(s, await port.transactions(s.nextCursor));
    expect(s.items).toHaveLength(25);
    expect(canLoadMore(s)).toBe(false);
  });
  it("does not duplicate rows on a replayed page", async () => {
    const port = new InMemoryWalletPort();
    const first = await port.transactions(null);
    const s = appendPage(appendPage(EMPTY_TRANSACTIONS, first), first);
    expect(s.items).toHaveLength(first.items.length);
  });
  it("reports offline versus failed", async () => {
    const port = new InMemoryWalletPort(undefined, undefined, "offline");
    expect(walletFailureState(await port.load().catch((e: unknown) => e))).toEqual({ status: "error", offline: true });
  });
});

describe("closed loop: nothing moves value out or in from the app", () => {
  const FORBIDDEN = /top.?up|withdraw|transfer|deposit|cash.?out|send|payout|add.?money/i;
  it("the port and the view expose only reads", () => {
    const names = Object.getOwnPropertyNames(InMemoryWalletPort.prototype).filter((n) => n !== "constructor");
    expect(names.sort()).toEqual(["check", "load", "setFailure", "transactions"]);
    for (const n of names) expect(FORBIDDEN.test(n), n).toBe(false);
    const v = buildWallet(fixtureWallet(NOW));
    for (const k of Object.keys(v)) expect(FORBIDDEN.test(k), k).toBe(false);
    expect(Object.keys(v).sort()).toEqual(["expiringSoon", "isEmpty", "subs", "total"]);
  });
});

function leaves(o: unknown): string[] {
  if (typeof o === "string") return [o];
  if (o !== null && typeof o === "object") return Object.values(o).flatMap(leaves);
  return [];
}

describe("wallet copy lint", () => {
  const BANNED = [/\bcash\b/i, /\bmoney\b/i, /top.?up/i, /withdraw/i, /transfer/i, /نقد/, /فلوس/, /سحب/, /تحويل/, /شحن الرصيد/];
  for (const lang of ["en", "ar"] as const) {
    it(`${lang}: wallet, gift card and plus strings never say cash or money, or offer top-up, withdraw or transfer`, () => {
      for (const ns of ["wallet", "giftCards", "plus"] as const) {
        for (const s of leaves(resources[lang][ns])) for (const re of BANNED) expect(re.test(s), s).toBe(false);
      }
    });
  }
  it("names the wallet with the product placeholder, not a hard-coded name", () => {
    expect(resources.en.wallet.title).toBe("{{product}} credit");
  });
});
