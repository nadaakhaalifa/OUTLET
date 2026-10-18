import { beforeEach, describe, expect, it } from "vitest";
import type { ReconStore } from "../domain/ports";
import { DAY, T0, csv, kit, type Kit, type TestClock } from "./fixtures";

export interface ReconScenarioContext {
  readonly store: ReconStore;
  readonly clock: TestClock;
  outboxTypes(): Promise<string[]>;
}

const BASE = T0 - 2 * DAY;

/** Behaviour of reconciliation on top of any ReconStore. Run against in-memory and Kysely/PGlite. */
export function describeReconScenarios(name: string, make: () => Promise<ReconScenarioContext>): void {
  describe(`Reconciliation scenarios: ${name}`, () => {
    let c: ReconScenarioContext;
    let k: Kit;

    beforeEach(async () => {
      c = await make();
      k = kit(c.store, c.clock);
    });

    const ingestGood = async (id = "S1") =>
      k.ingest.execute({
        kind: "psp",
        provider: "fakepay",
        format: "fixture_csv_v1",
        content: csv(id, [
          { no: 1, ref: "ref-1", gross: 10_000n, fee: 250n, at: BASE },
          { no: 2, ref: "ref-2", gross: 5_000n, fee: 125n, at: BASE + 1000 },
          { no: 3, ref: "ref-3", gross: -3_000n, at: BASE + 2000 },
        ]),
      });
    const matchingLedger = (): void => {
      k.clearing.addLine("psp", "fakepay", { id: "l1", key: "ref-1", amount: 10_000n, atMs: BASE });
      k.clearing.addLine("psp", "fakepay", { id: "l2", key: "ref-2", amount: 5_000n, atMs: BASE + 1000 });
      k.clearing.addLine("psp", "fakepay", { id: "l3", key: "ref-3", amount: -3_000n, atMs: BASE + 2000 });
      k.clearing.post("psp", "fakepay", "S1", 12_000n, 375n);
    };

    it("ingests a file once and treats a repeat as a duplicate", async () => {
      const first = await ingestGood();
      expect(first.kind).toBe("stored");
      const again = await ingestGood();
      expect(again.kind).toBe("duplicate");
      const files = await c.store.listFiles(10);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ status: "parsed", lineCount: 3, gross: 12_000n, fee: 375n, net: 11_625n });
    });

    it("stores an invalid file as rejected with codes and never matches it", async () => {
      const bad = await k.ingest.execute({
        kind: "psp",
        provider: "fakepay",
        format: "fixture_csv_v1",
        content: "settlement_id,provider\nS1,fakepay",
      });
      expect(bad.kind).toBe("rejected");
      const files = await c.store.listFiles(10);
      expect(files[0]?.status).toBe("rejected");
      expect(files[0]?.errorCodes).toEqual(["bad_header"]);
      expect(await c.store.parsedFilesSince(0)).toEqual([]);
      const run = await k.runner.execute("nightly");
      expect(run).toMatchObject({ kind: "completed", findings: 1, opened: 1 });
      const t = await c.store.listTickets({ after: null, limit: 10 });
      expect(t.items[0]).toMatchObject({ kind: "file_rejected", severity: "high" });
    });

    it("rejects a different file reusing a settlement id and an oversized file", async () => {
      await ingestGood("S1");
      const clash = await k.ingest.execute({
        kind: "psp",
        provider: "fakepay",
        format: "fixture_csv_v1",
        content: csv("S1", [{ no: 1, ref: "other", gross: 1n, at: BASE }]),
      });
      expect(clash).toMatchObject({ kind: "rejected", codes: ["settlement_id_conflict"] });
      const big = await k.ingest.execute({
        kind: "psp",
        provider: "fakepay",
        format: "fixture_csv_v1",
        content: "x".repeat(5_000_001),
      });
      expect(big.kind).toBe("too_large");
    });

    it("is clean when file, ledger and posting agree", async () => {
      await ingestGood();
      matchingLedger();
      const r = await k.runner.execute("nightly");
      expect(r).toMatchObject({ kind: "completed", findings: 0, opened: 0, ok: true });
      const s = await c.store.summary(c.clock.nowMs());
      expect(s.open + s.escalated).toBe(0);
      expect(s.lastRun?.ok).toBe(true);
      expect(await c.outboxTypes()).toEqual(["reconciliation.run_completed"]);
    });

    it("finds a one piastre difference, opens one high ticket and alerts once", async () => {
      await ingestGood();
      matchingLedger();
      k.clearing.lines.set("psp:fakepay", [
        { id: "l1", key: "ref-1", amount: 10_001n, atMs: BASE },
        { id: "l2", key: "ref-2", amount: 5_000n, atMs: BASE + 1000 },
        { id: "l3", key: "ref-3", amount: -3_000n, atMs: BASE + 2000 },
      ]);
      const r = await k.runner.execute("nightly");
      expect(r).toMatchObject({ kind: "completed", findings: 1, opened: 1, escalated: 0 });
      const t = (await c.store.listTickets({ after: null, limit: 10 })).items[0];
      expect(t).toMatchObject({ kind: "amount_mismatch", severity: "high", status: "open", amountDelta: -1n, ref: "ref-1" });
      expect(k.alerts.sent.map((a) => a.type)).toEqual(["ticket_opened"]);
      expect(k.alerts.sent[0]?.ticketId).toBe(t?.id);
      expect(await c.outboxTypes()).toEqual(["reconciliation.run_completed", "reconciliation.ticket_opened"]);
    });

    it("escalates an old unmatched line once and keeps its original ticket id", async () => {
      await ingestGood();
      matchingLedger();
      // a ledger movement the provider never reported, 4 days old
      k.clearing.addLine("psp", "fakepay", { id: "orphan", key: "ref-9", amount: 777n, atMs: BASE });
      const first = await k.runner.execute("nightly");
      expect(first).toMatchObject({ kind: "completed", findings: 1, opened: 1, escalated: 0 });
      const ticket = (await c.store.listTickets({ after: null, limit: 10 })).items[0];
      expect(ticket?.status).toBe("open");

      // two more days: item is now 4 days old, strictly above the 3 day aging limit
      k.clock.advance(2 * DAY);
      const second = await k.runner.execute("nightly");
      expect(second).toMatchObject({ kind: "completed", opened: 0, escalated: 1 });
      const after = await c.store.getTicket(ticket?.id ?? "");
      expect(after?.status).toBe("escalated");
      expect(after?.escalatedAtMs).not.toBeNull();
      expect(k.alerts.sent.map((a) => [a.type, a.ticketId])).toEqual([
        ["ticket_opened", ticket?.id],
        ["ticket_escalated", ticket?.id],
      ]);

      // a third night does not escalate again
      k.clock.advance(DAY);
      const third = await k.runner.execute("nightly");
      expect(third).toMatchObject({ opened: 0, escalated: 0 });
      expect(k.alerts.sent).toHaveLength(2);
    });

    it("resolves a ticket automatically once the finding disappears", async () => {
      await ingestGood();
      matchingLedger();
      k.clearing.addLine("psp", "fakepay", { id: "orphan", key: "ref-9", amount: 777n, atMs: BASE });
      await k.runner.execute("nightly");
      k.clearing.lines.set(
        "psp:fakepay",
        (k.clearing.lines.get("psp:fakepay") ?? []).filter((l) => l.id !== "orphan"),
      );
      k.clock.advance(DAY);
      const r = await k.runner.execute("nightly");
      expect(r).toMatchObject({ kind: "completed", findings: 0, resolved: 1, ok: true });
      const t = (await c.store.listTickets({ after: null, limit: 10 })).items[0];
      expect(t?.status).toBe("resolved");
      expect(t?.resolvedAtMs).not.toBeNull();
    });

    it("reopens a resolved ticket when the same problem comes back", async () => {
      await ingestGood();
      matchingLedger();
      k.clearing.addLine("psp", "fakepay", { id: "orphan", key: "ref-9", amount: 777n, atMs: BASE });
      await k.runner.execute("nightly");
      const original = (await c.store.listTickets({ after: null, limit: 10 })).items[0];
      const kept = k.clearing.lines.get("psp:fakepay") ?? [];
      k.clearing.lines.set("psp:fakepay", kept.filter((l) => l.id !== "orphan"));
      k.clock.advance(DAY);
      await k.runner.execute("nightly");
      k.clearing.lines.set("psp:fakepay", kept);
      k.clock.advance(DAY);
      const again = await k.runner.execute("nightly");
      expect(again).toMatchObject({ opened: 1 });
      const t = await c.store.getTicket(original?.id ?? "");
      expect(t?.status === "open" || t?.status === "escalated").toBe(true);
      expect(t?.resolvedAtMs).toBeNull();
    });

    it("intraday runs never auto-resolve tickets", async () => {
      await ingestGood();
      matchingLedger();
      k.clearing.addLine("psp", "fakepay", { id: "orphan", key: "ref-9", amount: 777n, atMs: BASE });
      await k.runner.execute("nightly");
      k.clearing.lines.set(
        "psp:fakepay",
        (k.clearing.lines.get("psp:fakepay") ?? []).filter((l) => l.id !== "orphan"),
      );
      k.clock.advance(3_600_000);
      const r = await k.runner.execute("intraday");
      expect(r).toMatchObject({ kind: "completed", resolved: 0 });
      expect((await c.store.listTickets({ after: null, limit: 10 })).items[0]?.status).not.toBe("resolved");
    });

    it("flags an unposted settlement and a posting that differs from the file", async () => {
      await ingestGood();
      k.clearing.addLine("psp", "fakepay", { id: "l1", key: "ref-1", amount: 10_000n, atMs: BASE });
      k.clearing.addLine("psp", "fakepay", { id: "l2", key: "ref-2", amount: 5_000n, atMs: BASE + 1000 });
      k.clearing.addLine("psp", "fakepay", { id: "l3", key: "ref-3", amount: -3_000n, atMs: BASE + 2000 });
      await k.runner.execute("nightly");
      let t = (await c.store.listTickets({ after: null, limit: 10 })).items;
      expect(t.map((x) => x.kind)).toEqual(["settlement_not_posted"]);
      k.clearing.post("psp", "fakepay", "S1", 12_000n, 400n);
      k.clock.advance(DAY);
      await k.runner.execute("nightly");
      t = (await c.store.listTickets({ after: null, limit: 10 })).items;
      expect(t.map((x) => [x.kind, x.status]).sort()).toEqual([
        ["settlement_not_posted", "resolved"],
        ["settlement_posting_mismatch", "open"],
      ]);
    });

    it("raises a critical, immediately escalated ticket for an unbalanced ledger", async () => {
      k.integrity.totalsByCurrency = new Map([["EGP", 5n]]);
      const r = await k.runner.execute("nightly");
      expect(r).toMatchObject({ kind: "completed", opened: 1, escalated: 1, ok: false });
      expect((await c.store.listTickets({ after: null, limit: 10 })).items[0]).toMatchObject({
        kind: "trial_balance",
        severity: "critical",
        status: "escalated",
      });
      expect(k.alerts.sent.map((a) => a.type)).toEqual(["ticket_opened", "ticket_escalated"]);
    });

    it("a failing suite becomes a critical finding and the other suites still run", async () => {
      k.integrity.failTotals = true;
      k.integrity.projectionRows = [{ userId: "u1", sub: "refund_credit", balance: 100n }];
      const r = await k.runner.execute("nightly");
      expect(r).toMatchObject({ kind: "completed", findings: 2 });
      const kinds = (await c.store.listTickets({ after: null, limit: 10 })).items.map((t) => t.kind).sort();
      expect(kinds).toEqual(["store_credit_drift", "suite_failed"]);
    });

    it("reports ETA rejected, missing and mismatched documents", async () => {
      k.eta.internalDocs.push(
        { internalId: "d1", state: "REJECTED", gross: 100n, lastSubmittedAtMs: T0 - 1000, createdAtMs: T0 - 2000 },
        { internalId: "d2", state: "ACCEPTED", gross: 100n, lastSubmittedAtMs: T0 - 1000, createdAtMs: T0 - 2000 },
      );
      const r = await k.runner.execute("nightly");
      expect(r).toMatchObject({ findings: 2 });
      const kinds = (await c.store.listTickets({ after: null, limit: 10 })).items.map((t) => t.kind).sort();
      expect(kinds).toEqual(["eta_missing_at_authority", "eta_rejected"]);
    });

    it("an alert channel outage does not undo the tickets", async () => {
      k.integrity.totalsByCurrency = new Map([["EGP", 1n]]);
      k.alerts.fail = true;
      const r = await k.runner.execute("nightly");
      expect(r).toMatchObject({ kind: "completed", opened: 1, alertFailures: 2 });
      expect((await c.store.summary(c.clock.nowMs())).escalated).toBe(1);
    });

    it("runs the nightly job once per Cairo date and intraday only in event mode", async () => {
      const a = await k.scheduler.tick();
      expect(a.map((x) => (x.kind === "completed" ? x.mode : x.kind))).toEqual(["nightly"]);
      expect(await k.scheduler.tick()).toEqual([]);
      const doubled = await k.runner.execute("nightly");
      expect(doubled).toEqual({ kind: "already_ran" });
      k.flags.intraday = true;
      k.clock.advance(3 * 3_600_000);
      expect((await k.scheduler.tick()).map((x) => (x.kind === "completed" ? x.mode : x.kind))).toEqual(["intraday"]);
      k.clock.advance(60_000);
      expect(await k.scheduler.tick()).toEqual([]);
      k.clock.advance(DAY);
      expect((await k.scheduler.tick()).map((x) => (x.kind === "completed" ? x.mode : x.kind))).toEqual(["nightly", "intraday"]);
    });

    it("summarises aging, severity and source for Finance", async () => {
      k.integrity.totalsByCurrency = new Map([["EGP", 1n]]);
      await ingestGood();
      matchingLedger();
      k.clearing.addLine("psp", "fakepay", { id: "orphan", key: "ref-9", amount: 777n, atMs: BASE });
      await k.runner.execute("nightly");
      const s = await k.read.summary();
      expect(s.bySeverity).toEqual({ critical: 1, high: 0, medium: 1 });
      expect(s.bySource).toEqual({ trial_balance: 1, psp_settlement: 1 });
      expect(s.oldestItemAtMs).toBe(BASE);
      expect(s.lastRun?.findingCount).toBe(2);
      // B-2: buckets partition the live tickets of each source; both adapters agree on the boundaries.
      const live = (src: "psp_settlement" | "trial_balance") => s.bySource[src] ?? 0;
      for (const src of ["psp_settlement", "trial_balance"] as const) {
        const a = s.aging[src];
        expect(a.lt1d + a.d1to3 + a.gt3d).toBe(live(src));
      }
      expect(s.rails.find((r) => r.source === "psp_settlement")?.filesReceived).toBe(1);
      expect(s.rails.find((r) => r.source === "cod_remittance")).toMatchObject({ filesReceived: 0, lastFileAtMs: null, input: "unconfigured" });
      expect(s.rails.find((r) => r.source === "eta_submission")?.filesReceived).toBeNull();
      const raw = await c.store.summary(BASE + 72 * 3_600_000);
      expect(raw.aging?.psp_settlement?.d1to3).toBe(1);
      expect((await c.store.summary(BASE + 72 * 3_600_000 + 1)).aging?.psp_settlement?.gt3d).toBe(1);
      expect((await c.store.summary(BASE + 24 * 3_600_000 - 1)).aging?.psp_settlement?.lt1d).toBe(1);
    });

    it("paginates tickets by item time", async () => {
      await ingestGood();
      matchingLedger();
      for (let i = 0; i < 3; i += 1) {
        k.clearing.addLine("psp", "fakepay", { id: `o${i}`, key: `orphan-${i}`, amount: BigInt(100 + i), atMs: BASE + i });
      }
      await k.runner.execute("nightly");
      const first = await c.store.listTickets({ after: null, limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.next).not.toBeNull();
      const second = await c.store.listTickets({ after: first.next, limit: 2 });
      expect(second.items).toHaveLength(1);
      expect(second.next).toBeNull();
      const only = await c.store.listTickets({ status: "resolved", after: null, limit: 5 });
      expect(only.items).toEqual([]);
    });

    it("exact bigint piastres beyond 2^53 survive storage", async () => {
      const big = 9_007_199_254_740_993n;
      k.integrity.totalsByCurrency = new Map([["EGP", big]]);
      await k.runner.execute("nightly");
      expect((await c.store.listTickets({ after: null, limit: 5 })).items[0]?.amountDelta).toBe(big);
    });
  });
}
