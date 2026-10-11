import { describe, expect, it } from "vitest";
import {
  GiftCardSalesDisabledError,
  PostingConflictError,
  chart,
  money,
  type PostingCommand,
} from "../domain/bridge";
import { LedgerEntryNotFoundError, type PostingService } from "../application/posting-service";
import type { IntegrityJobReport } from "../application/integrity-job";
import type { BalanceRow, LedgerReadModel, LedgerTxn, StoredEntry } from "../domain/ports";

/** The posting service bound to one open transaction, so the suite does not know the adapter. */
export interface BoundPosting {
  postCommand(cmd: PostingCommand): ReturnType<PostingService<LedgerTxn>["postCommand"]>;
  reversal(entryId: string): ReturnType<PostingService<LedgerTxn>["reversal"]>;
  /** The caller's own state change that must commit or roll back with the posting. */
  markState(label: string): Promise<void>;
  /** Emits a caller outbox event in the same transaction. */
  emitCaller(type: string): Promise<void>;
}

export interface LedgerHarness {
  run<R>(fn: (p: BoundPosting) => Promise<R>): Promise<R>;
  reads: LedgerReadModel;
  setGiftCardFlag(on: boolean): void;
  integrity(): Promise<IntegrityJobReport>;
  /** Labels committed by markState. */
  committedState(): Promise<readonly string[]>;
  outboxTypes(): Promise<readonly string[]>;
  /** Adapter-specific corruption used to prove the integrity job notices. */
  tamperPostingAmount(entryId: string): Promise<void>;
  setProjection(rows: { userId: string; sub: string; balance: bigint }[]): void;
}

export const SCOPE = { actorId: "00000000-0000-4000-8000-0000000000f1", role: "finance" } as const;
const E = (n: bigint) => money(n);

export const orderCmd = (group: string, over: Partial<Extract<PostingCommand, { type: "order_paid" }>> = {}): PostingCommand => ({
  type: "order_paid",
  orderGroupId: group,
  storeOrders: [
    { storeId: "A", merchandise: E(159_950n), commissionBps: 1_500n },
    { storeId: "B", merchandise: E(60_025n), commissionBps: 1_000n },
  ],
  shippingGross: E(7_500n),
  vatBps: 1_400n,
  external: { kind: "psp", psp: "paymob" },
  ...over,
});

export function describeLedgerContract(name: string, fresh: () => Promise<LedgerHarness>): void {
  describe(`ledger posting contract: ${name}`, () => {
    it("posts a balanced order entry and reads balances derived from postings", async () => {
      const h = await fresh();
      const out = await h.run((p) => p.postCommand(orderCmd("og_1")));
      expect(out.kind).toBe("posted");
      const rows = await h.reads.balances(SCOPE, { type: "seller_payable", limit: 50 });
      const a = rows.find((r) => r.account === chart.sellerPayable("A"));
      expect(a?.natural).toBeGreaterThan(0n);
      const report = await h.integrity();
      expect(report.ok).toBe(true);
      expect(report.trialBalance.ok).toBe(true);
      expect(report.chain).toMatchObject({ ok: true, length: 1 });
    });

    it("replays the same key and payload as the same entry, one row, one event", async () => {
      const h = await fresh();
      const first = await h.run((p) => p.postCommand(orderCmd("og_2")));
      const second = await h.run((p) => p.postCommand(orderCmd("og_2")));
      expect(second.kind).toBe("replayed");
      expect(second.stored.entry.id).toBe(first.stored.entry.id);
      expect((await h.outboxTypes()).filter((t) => t === "ledger.entry_posted")).toHaveLength(1);
      expect((await h.integrity()).chain).toMatchObject({ ok: true, length: 1 });
    });

    it("rejects the same key with a different payload as a typed conflict and writes nothing", async () => {
      const h = await fresh();
      await h.run((p) => p.postCommand(orderCmd("og_3")));
      const changed = orderCmd("og_3", { shippingGross: E(9_000n) });
      await expect(h.run((p) => p.postCommand(changed))).rejects.toBeInstanceOf(PostingConflictError);
      expect((await h.integrity()).chain).toMatchObject({ ok: true, length: 1 });
    });

    it("concurrent posts with one key produce exactly one entry", async () => {
      const h = await fresh();
      const results = await Promise.all(
        Array.from({ length: 4 }, () => h.run((p) => p.postCommand(orderCmd("og_race")))),
      );
      expect(new Set(results.map((r) => r.stored.entry.id)).size).toBe(1);
      expect(results.filter((r) => r.kind === "posted")).toHaveLength(1);
      expect((await h.integrity()).chain).toMatchObject({ ok: true, length: 1 });
    });

    it("rolls the posting back with the caller's state change and events", async () => {
      const h = await fresh();
      await expect(
        h.run(async (p) => {
          await p.markState("order_paid");
          await p.emitCaller("order_group.paid");
          await p.postCommand(orderCmd("og_rb"));
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await h.committedState()).toEqual([]);
      expect(await h.outboxTypes()).toEqual([]);
      expect((await h.integrity()).chain).toMatchObject({ ok: true, length: 0 });
      // after the rollback the same key posts fresh
      expect((await h.run((p) => p.postCommand(orderCmd("og_rb")))).kind).toBe("posted");
    });

    it("commits posting, state change and outbox events together", async () => {
      const h = await fresh();
      await h.run(async (p) => {
        await p.markState("order_paid");
        await p.emitCaller("order_group.paid");
        await p.postCommand(orderCmd("og_ok"));
      });
      expect(await h.committedState()).toEqual(["order_paid"]);
      expect([...(await h.outboxTypes())].sort()).toEqual(["ledger.entry_posted", "order_group.paid"]);
    });

    it("reversal mirrors every posting, nets every account to zero, and repeats as the same entry", async () => {
      const h = await fresh();
      const original = await h.run((p) => p.postCommand(orderCmd("og_rev")));
      const rev = await h.run((p) => p.reversal(original.stored.entry.id));
      expect(rev.kind).toBe("posted");
      const again = await h.run((p) => p.reversal(original.stored.entry.id));
      expect(again.kind).toBe("replayed");
      expect(again.stored.entry.id).toBe(rev.stored.entry.id);
      const rows = await h.reads.balances(SCOPE, { limit: 200 });
      expect(rows.every((r: BalanceRow) => r.raw === 0n)).toBe(true);
      expect((await h.outboxTypes()).filter((t) => t === "ledger.entry_reversed")).toHaveLength(1);
      expect((await h.integrity()).ok).toBe(true);
    });

    it("refuses to reverse a missing entry and a reversal", async () => {
      const h = await fresh();
      await expect(h.run((p) => p.reversal("00000000-0000-4000-8000-0000000000aa"))).rejects.toBeInstanceOf(
        LedgerEntryNotFoundError,
      );
      const original = await h.run((p) => p.postCommand(orderCmd("og_rr")));
      const rev = await h.run((p) => p.reversal(original.stored.entry.id));
      await expect(h.run((p) => p.reversal(rev.stored.entry.id))).rejects.toBeInstanceOf(Error);
    });

    it("gift card entries need the kill switch on", async () => {
      const h = await fresh();
      const sale: PostingCommand = {
        type: "gift_card_sold",
        cardId: "gc_1",
        tender: { kind: "psp", psp: "paymob", amount: E(50_000n) },
      };
      h.setGiftCardFlag(false);
      await expect(h.run((p) => p.postCommand(sale))).rejects.toBeInstanceOf(GiftCardSalesDisabledError);
      expect((await h.integrity()).chain).toMatchObject({ length: 0 });
    });

    it("reports a hash-chain break at the exact link when a posting is tampered", async () => {
      const h = await fresh();
      await h.run((p) => p.postCommand(orderCmd("og_t1")));
      const second = await h.run((p) => p.postCommand(orderCmd("og_t2")));
      await h.tamperPostingAmount(second.stored.entry.id);
      const report = await h.integrity();
      expect(report.ok).toBe(false);
      expect(report.chain.ok).toBe(false);
    });

    it("reports per-user store-credit drift against the projection", async () => {
      const h = await fresh();
      const user = "00000000-0000-4000-8000-0000000000c1";
      await h.run((p) =>
        p.postCommand({
          type: "store_credit_issue",
          grantId: "grant_1",
          userId: user,
          sub: { kind: "goodwill" },
          amount: E(5_000n),
        }),
      );
      h.setProjection([{ userId: user, sub: "goodwill", balance: 5_000n }]);
      expect((await h.integrity()).storeCredit.drift).toEqual([]);
      h.setProjection([{ userId: user, sub: "goodwill", balance: 4_000n }]);
      const drifted = await h.integrity();
      expect(drifted.ok).toBe(false);
      expect(drifted.storeCredit.drift.length).toBeGreaterThan(0);
    });

    it("reads one entry by id with its chain link and returns null for unknown ids", async () => {
      const h = await fresh();
      const posted = await h.run((p) => p.postCommand(orderCmd("og_read")));
      const got: StoredEntry | null = await h.reads.entry(SCOPE, posted.stored.entry.id);
      expect(got?.entry.postings.length).toBe(posted.stored.entry.postings.length);
      expect(got?.link.entryHash).toBe(posted.stored.link.entryHash);
      expect(await h.reads.entry(SCOPE, "00000000-0000-4000-8000-0000000000ee")).toBeNull();
      expect(await h.reads.entry(SCOPE, "not-a-uuid")).toBeNull();
    });
  });
}
