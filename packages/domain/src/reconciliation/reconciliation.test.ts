import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECON_SCHEDULE,
  ESCALATE_AFTER_MS,
  SETTLEMENT_CSV_HEADER,
  matchLines,
  parseSettlementCsv,
  planTickets,
  reconcileAcrossFiles,
  reconcileEta,
  reconcileSettlementFile,
  reconcileStoreCredit,
  reconcileTrialBalance,
  reconciliationDue,
  shouldEscalate,
  conserves,
  type Finding,
  type ReconLine,
  type TicketSnapshot,
} from "./index";

const L = (id: string, key: string, amount: bigint, atMs = 1_000): ReconLine => ({ id, key, amount, atMs });
const DAY = 86_400_000;

describe("matchLines", () => {
  it("matches equal amounts by reference and reports mismatches, unmatched and duplicates", () => {
    const r = matchLines(
      [L("e1", "a", 100n), L("e2", "b", 200n), L("e3", "c", 300n), L("e4", "a", 100n), L("e5", "d", 50n)],
      [L("i1", "a", 100n), L("i2", "b", 199n), L("i3", "z", 7n)],
    );
    expect(r.matched).toEqual([{ key: "a", externalId: "e1", internalId: "i1", amount: 100n }]);
    expect(r.mismatched.map((m) => [m.key, m.external, m.internal])).toEqual([["b", 200n, 199n]]);
    expect(r.duplicateExternal.map((l) => l.id)).toEqual(["e4"]);
    expect(r.unmatchedExternal.map((l) => l.id)).toEqual(["e3", "e5"]);
    expect(r.unmatchedInternal.map((l) => l.id)).toEqual(["i3"]);
    expect(conserves(r)).toBe(true);
  });

  it("handles a capture and a refund with the same reference independently", () => {
    const r = matchLines([L("e1", "r", 500n), L("e2", "r", -500n)], [L("i1", "r", -500n), L("i2", "r", 500n)]);
    expect(r.matched).toHaveLength(2);
    expect(r.mismatched).toHaveLength(0);
  });

  it("flags a doubled internal posting", () => {
    const r = matchLines([L("e1", "a", 100n)], [L("i1", "a", 100n), L("i2", "a", 100n)]);
    expect(r.duplicateInternal.map((l) => l.id)).toEqual(["i2"]);
  });

  it("rejects duplicate ids within a side", () => {
    expect(() => matchLines([L("x", "a", 1n), L("x", "b", 1n)], [])).toThrow();
    expect(() => matchLines([], [L("x", "a", 1n), L("x", "b", 1n)])).toThrow();
  });
});

const header = SETTLEMENT_CSV_HEADER;
const csv = (rows: string[]): string => [header, ...rows].join("\n");

describe("parseSettlementCsv", () => {
  const good = csv([
    "S1,fakepay,1,capture,ref-1,10000,250,9750,EGP,2026-10-11T08:00:00Z",
    "S1,fakepay,2,refund,ref-2,-3000,0,-3000,EGP,2026-10-11T09:00:00Z",
    "TOTAL,,,,,7000,250,6750,EGP,",
  ]);

  it("parses a valid file with exact totals", () => {
    const r = parseSettlementCsv(good, { provider: "fakepay" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.file.settlementId).toBe("S1");
      expect(r.file.lines).toHaveLength(2);
      expect(r.file.totals).toEqual({ gross: 7000n, fee: 250n, net: 6750n });
      expect(r.file.lines[1]?.gross).toBe(-3000n);
    }
  });

  const codes = (content: string): string[] => {
    const r = parseSettlementCsv(content, { provider: "fakepay" });
    return r.ok ? [] : r.errors.map((e) => e.code);
  };

  it("reports every class of problem by code", () => {
    expect(codes("")).toEqual(["empty_file"]);
    expect(codes("nope\nx")).toEqual(["bad_header"]);
    expect(codes(csv(["TOTAL,,,,,0,0,0,EGP,"]))).toContain("empty_file");
    expect(codes(csv(["S1,fakepay,1,capture,r,1,0,2,EGP,2026-10-11T08:00:00Z", "TOTAL,,,,,1,0,2,EGP,"]))).toContain("line_arithmetic");
    expect(codes(csv(["S1,other,1,capture,r,1,0,1,EGP,2026-10-11T08:00:00Z", "TOTAL,,,,,1,0,1,EGP,"]))).toContain("provider_mismatch");
    expect(codes(csv(["S1,fakepay,1,capture,r,1,0,1,USD,2026-10-11T08:00:00Z", "TOTAL,,,,,1,0,1,EGP,"]))).toContain("bad_currency");
    expect(codes(csv(["S1,fakepay,1,capture,r,1,0,1,EGP,yesterday", "TOTAL,,,,,1,0,1,EGP,"]))).toContain("bad_timestamp");
    expect(codes(csv(["S1,fakepay,1,refund,r,5,0,5,EGP,2026-10-11T08:00:00Z", "TOTAL,,,,,5,0,5,EGP,"]))).toContain("sign_mismatch");
    expect(codes(csv(["S1,fakepay,1,capture,r,1,-1,2,EGP,2026-10-11T08:00:00Z", "TOTAL,,,,,1,-1,2,EGP,"]))).toContain("negative_fee");
    expect(codes(csv(["S1,fakepay,1,capture,r,1.5,0,1,EGP,2026-10-11T08:00:00Z", "TOTAL,,,,,1,0,1,EGP,"]))).toContain("bad_amount");
    expect(codes(csv(["S1,fakepay,1,boom,r,1,0,1,EGP,2026-10-11T08:00:00Z", "TOTAL,,,,,1,0,1,EGP,"]))).toContain("bad_kind");
    expect(codes(csv(["S1,fakepay,1,capture,bad ref!,1,0,1,EGP,2026-10-11T08:00:00Z", "TOTAL,,,,,1,0,1,EGP,"]))).toContain("bad_ref");
    expect(codes(csv(['S1,fakepay,1,capture,"r",1,0,1,EGP,2026-10-11T08:00:00Z', "TOTAL,,,,,1,0,1,EGP,"]))).toContain("quotes_unsupported");
    expect(codes(csv(["S1,fakepay,1,capture"]))).toContain("bad_column_count");
    expect(codes(csv(["S1,fakepay,0,capture,r,1,0,1,EGP,2026-10-11T08:00:00Z", "TOTAL,,,,,1,0,1,EGP,"]))).toContain("bad_line_no");
    expect(codes(csv(["S1,fakepay,1,capture,r,1,0,1,EGP,2026-10-11T08:00:00Z", "S2,fakepay,2,capture,r2,1,0,1,EGP,2026-10-11T08:00:00Z", "TOTAL,,,,,2,0,2,EGP,"]))).toContain("settlement_id_mismatch");
    expect(codes(csv(["S1,fakepay,1,capture,r,1,0,1,EGP,2026-10-11T08:00:00Z", "S1,fakepay,1,capture,r2,1,0,1,EGP,2026-10-11T08:00:00Z", "TOTAL,,,,,2,0,2,EGP,"]))).toContain("duplicate_line_no");
  });

  it("requires a TOTAL row that equals the sum of the lines", () => {
    expect(codes(csv(["S1,fakepay,1,capture,r,1,0,1,EGP,2026-10-11T08:00:00Z"]))).toContain("missing_total");
    expect(codes(csv(["S1,fakepay,1,capture,r,1,0,1,EGP,2026-10-11T08:00:00Z", "TOTAL,,,,,9,0,9,EGP,"]))).toContain("total_mismatch");
  });

  it("accepts CRLF and trailing blank lines", () => {
    expect(parseSettlementCsv(good.replace(/\n/g, "\r\n") + "\r\n\r\n", { provider: "fakepay" }).ok).toBe(true);
  });
});

describe("reconcileSettlementFile", () => {
  const parsed = (() => {
    const r = parseSettlementCsv(
      csv([
        "S1,fakepay,1,capture,ref-1,10000,250,9750,EGP,2026-10-11T08:00:00Z",
        "S1,fakepay,2,capture,ref-2,5000,125,4875,EGP,2026-10-11T09:00:00Z",
        "TOTAL,,,,,15000,375,14625,EGP,",
      ]),
      { provider: "fakepay" },
    );
    if (!r.ok) throw new Error("fixture invalid");
    return r.file;
  })();
  const internal = [L("l1", "ref-1", 10000n), L("l2", "ref-2", 5000n)];

  it("is clean when lines and posting agree", () => {
    const r = reconcileSettlementFile({ source: "psp_settlement", file: parsed, internal, posted: { gross: 15000n, fee: 375n } });
    expect(r.findings).toEqual([]);
    expect(r.match.matched).toHaveLength(2);
  });

  it("finds a one piastre difference as a high amount mismatch", () => {
    const r = reconcileSettlementFile({
      source: "psp_settlement",
      file: parsed,
      internal: [L("l1", "ref-1", 10001n), L("l2", "ref-2", 5000n)],
      posted: { gross: 15000n, fee: 375n },
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ kind: "amount_mismatch", severity: "high", delta: -1n, ref: "ref-1" });
  });

  it("reports an unposted settlement and a posting that differs from the file", () => {
    const unposted = reconcileSettlementFile({ source: "bnpl_settlement", file: parsed, internal, posted: null });
    expect(unposted.findings.map((f) => f.kind)).toEqual(["settlement_not_posted"]);
    expect(unposted.findings[0]?.delta).toBe(14625n);
    const off = reconcileSettlementFile({ source: "cod_remittance", file: parsed, internal, posted: { gross: 15000n, fee: 400n } });
    expect(off.findings.map((f) => f.kind)).toEqual(["settlement_posting_mismatch"]);
    expect(off.findings[0]?.detail).toBe("gross_delta=0;fee_delta=-25");
  });
});

describe("reconcileEta", () => {
  const now = 100 * 3_600_000;
  it("covers rejected, missing, unknown, mismatched and stale", () => {
    const f = reconcileEta({
      nowMs: now,
      internal: [
        { internalId: "a", state: "ACCEPTED", gross: 100n, lastSubmittedAtMs: 1, createdAtMs: 0 },
        { internalId: "b", state: "ACCEPTED", gross: 100n, lastSubmittedAtMs: 1, createdAtMs: 0 },
        { internalId: "c", state: "REJECTED", gross: 100n, lastSubmittedAtMs: 1, createdAtMs: 0 },
        { internalId: "d", state: "SUBMITTED", gross: 100n, lastSubmittedAtMs: 1, createdAtMs: 0 },
        { internalId: "e", state: "SUBMITTED", gross: 100n, lastSubmittedAtMs: null, createdAtMs: now - 1000 },
        { internalId: "f", state: "QUEUED", gross: 100n, lastSubmittedAtMs: null, createdAtMs: 0 },
        { internalId: "g", state: "SUBMITTED", gross: 100n, lastSubmittedAtMs: 1, createdAtMs: 0 },
      ],
      reported: [
        { internalId: "a", status: "ACCEPTED" },
        { internalId: "b", status: "REJECTED" },
        { internalId: "d", status: "PENDING" },
        { internalId: "e", status: "PENDING" },
        { internalId: "g", status: "ACCEPTED" },
        { internalId: "zzz", status: "ACCEPTED" },
      ],
    });
    const kinds = Object.fromEntries(f.map((x) => [x.ref, x.kind]));
    expect(kinds).toEqual({
      b: "eta_status_mismatch",
      c: "eta_rejected",
      d: "eta_stale_submitted",
      g: "eta_status_mismatch",
      zzz: "eta_unknown_at_authority",
    });
  });

  it("reports an accepted document the authority never heard of", () => {
    const f = reconcileEta({
      nowMs: now,
      internal: [{ internalId: "a", state: "ACCEPTED", gross: 5n, lastSubmittedAtMs: 1, createdAtMs: 0 }],
      reported: [],
    });
    expect(f.map((x) => x.kind)).toEqual(["eta_missing_at_authority"]);
  });
});

describe("store credit and trial balance suites", () => {
  it("reports drift and negative balances", () => {
    const f = reconcileStoreCredit({
      nowMs: 5,
      projection: [{ userId: "u1", sub: "refund_credit", balance: 500n }],
      balances: [{ account: "store_credit:u1:refund_credit", currency: "EGP", raw: -400n }],
    });
    expect(f.map((x) => [x.kind, x.delta])).toEqual([["store_credit_drift", 100n]]);
    const neg = reconcileStoreCredit({
      nowMs: 5,
      projection: [{ userId: "u1", sub: "refund_credit", balance: -10n }],
      balances: [{ account: "store_credit:u1:refund_credit", currency: "EGP", raw: 10n }],
    });
    expect(neg.map((x) => x.kind).sort()).toEqual(["store_credit_negative"]);
  });

  it("raises a critical finding for an unbalanced currency only", () => {
    expect(reconcileTrialBalance(new Map([["EGP", 0n]]), 1)).toEqual([]);
    const f = reconcileTrialBalance(new Map([["EGP", 3n]]), 9);
    expect(f[0]).toMatchObject({ kind: "trial_balance", severity: "critical", delta: 3n });
  });
});

describe("tickets and aging", () => {
  const f = (key: string, atMs: number, severity: Finding["severity"] = "medium"): Finding => ({
    source: "psp_settlement",
    kind: "unmatched_internal",
    severity,
    ref: key,
    lineIds: [key],
    delta: 1n,
    atMs,
    dedupeKey: `k:${key}`,
    detail: "",
  });
  const now = 10 * DAY;

  it("escalates strictly after 3 days and critical at once", () => {
    expect(shouldEscalate({ severity: "medium", atMs: now - ESCALATE_AFTER_MS }, now)).toBe(false);
    expect(shouldEscalate({ severity: "medium", atMs: now - ESCALATE_AFTER_MS - 1 }, now)).toBe(true);
    expect(shouldEscalate({ severity: "critical", atMs: now }, now)).toBe(true);
  });

  it("opens, escalates once, continues and resolves", () => {
    const empty = new Map<string, TicketSnapshot>();
    const p1 = planTickets([f("a", now - DAY), f("b", now - 4 * DAY)], empty, now);
    expect(p1.opened.map((x) => x.ref)).toEqual(["a", "b"]);
    expect(p1.escalated.map((x) => x.ref)).toEqual(["b"]);
    const existing = new Map<string, TicketSnapshot>([
      ["k:a", { status: "open", firstSeenAtMs: now - DAY, escalatedAtMs: null }],
      ["k:b", { status: "escalated", firstSeenAtMs: now - 4 * DAY, escalatedAtMs: now - DAY }],
      ["k:gone", { status: "open", firstSeenAtMs: 0, escalatedAtMs: null }],
      ["k:done", { status: "resolved", firstSeenAtMs: 0, escalatedAtMs: null }],
    ]);
    const later = now + 3 * DAY;
    const p2 = planTickets([f("a", now - DAY), f("b", now - 4 * DAY), f("done", later)], existing, later);
    expect(p2.escalated.map((x) => x.ref)).toEqual(["a"]);
    expect(p2.continuing.map((x) => x.ref)).toEqual(["b"]);
    expect(p2.opened.map((x) => x.ref)).toEqual(["done"]);
    expect(p2.resolved).toEqual(["k:gone"]);
    expect(p2.statusByKey.get("k:b")).toBe("escalated");
  });
});

describe("schedule", () => {
  const T = Date.UTC(2026, 9, 11, 0, 30, 0); // 03:30 Cairo (UTC+3)
  it("runs the nightly job once per Cairo date after 02:00", () => {
    expect(reconciliationDue({ nowMs: T, lastNightlyKey: null, lastIntradayAtMs: null, intradayEnabled: false })).toEqual({
      nightly: true,
      nightlyKey: "2026-10-11",
      intraday: false,
    });
    expect(reconciliationDue({ nowMs: T, lastNightlyKey: "2026-10-11", lastIntradayAtMs: null, intradayEnabled: false }).nightly).toBe(false);
    // 01:30 Cairo is before the nightly hour
    expect(reconciliationDue({ nowMs: Date.UTC(2026, 9, 10, 22, 30, 0), lastNightlyKey: null, lastIntradayAtMs: null, intradayEnabled: false }).nightly).toBe(false);
  });
  it("runs intraday only when enabled and spaced", () => {
    const base = { nowMs: T, lastNightlyKey: "2026-10-11", intradayEnabled: true } as const;
    expect(reconciliationDue({ ...base, lastIntradayAtMs: null }).intraday).toBe(true);
    expect(reconciliationDue({ ...base, lastIntradayAtMs: T - DEFAULT_RECON_SCHEDULE.intradayEveryMs + 1 }).intraday).toBe(false);
    expect(reconciliationDue({ ...base, lastIntradayAtMs: T - DEFAULT_RECON_SCHEDULE.intradayEveryMs }).intraday).toBe(true);
    expect(reconciliationDue({ ...base, intradayEnabled: false, lastIntradayAtMs: null }).intraday).toBe(false);
  });
  it("rejects a nonsense schedule", () => {
    expect(() =>
      reconciliationDue({ nowMs: T, lastNightlyKey: null, lastIntradayAtMs: null, intradayEnabled: true, schedule: { nightlyHour: 25, intradayEveryMs: 60_000 } }),
    ).toThrow();
  });
});

describe("reconcileAcrossFiles (ADV-W4-4)", () => {
  const line = (lineNo: number, ref: string, gross: bigint, kind: "capture" | "refund" = "capture") => ({
    lineNo,
    kind,
    providerRef: ref,
    gross,
    fee: 0n,
    net: gross,
    occurredAtMs: 1,
  });
  const file = (settlementId: string, lines: ReturnType<typeof line>[]) => ({
    settlementId,
    provider: "p",
    lines,
    totals: { gross: 0n, fee: 0n, net: 0n },
  });
  it("flags a reference re-reported under a new settlement id, keeping the first file as owner", () => {
    const f = reconcileAcrossFiles("psp_settlement", [file("S2", [line(1, "r1", 100n)]), file("S1", [line(1, "r1", 100n)])]);
    expect(f.map((x) => [x.kind, x.lineIds[0]])).toEqual([["duplicate_external", "S2#1"]]);
  });
  it("does not flag a legitimate refund of the same reference, or other providers", () => {
    expect(reconcileAcrossFiles("psp_settlement", [file("S1", [line(1, "r1", 100n)]), file("S2", [line(1, "r1", -100n, "refund")])])).toEqual([]);
    const other = { ...file("S2", [line(1, "r1", 100n)]), provider: "q" };
    expect(reconcileAcrossFiles("psp_settlement", [file("S1", [line(1, "r1", 100n)]), other])).toEqual([]);
  });
});
