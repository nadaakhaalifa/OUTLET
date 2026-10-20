import { orderByPriority, type ClaimView, type ConflictOutcome } from "../domain/bridge";
import type {
  ApplicationOwnershipPort,
  ApplicationSnapshot,
  BrandVerificationStore,
  ClaimCandidateQuery,
  ConflictRecord,
  DnsResolverPort,
  DnsTxtResult,
  DomainVerificationRecord,
  Effects,
  HistoryDraft,
  NewConflict,
  OutboxDraft,
  ReportRecord,
  ResolveConflictStore,
  SanctionsScreeningPort,
  ScreeningRecord,
  TrademarkLookupRecord,
  TrademarkOffice,
  TrademarkRegistryPort,
  TrademarkRegistryResult,
  VerificationEmailPort,
  VerificationSecretPort,
} from "../domain/ports";

export class InMemoryBrandVerificationStore implements BrandVerificationStore {
  readonly outbox: OutboxDraft[] = [];
  readonly history: HistoryDraft[] = [];
  private readonly domains = new Map<string, DomainVerificationRecord>();
  private readonly claims = new Map<string, ClaimView>();
  private readonly conflicts = new Map<string, ConflictRecord>();
  private readonly lookups: TrademarkLookupRecord[] = [];
  private readonly screenings: ScreeningRecord[] = [];
  private readonly reports: ReportRecord[] = [];

  private apply(fx: Effects): void {
    this.outbox.push(...fx.outbox);
    this.history.push(...fx.history);
  }

  async getDomainVerification(id: string) {
    return this.domains.get(id) ?? null;
  }
  async saveDomainVerification(rec: DomainVerificationRecord, expected: number | null, fx: Effects) {
    const cur = this.domains.get(rec.applicationId);
    if (expected === null ? cur !== undefined : cur === undefined || cur.version !== expected) return "version_conflict" as const;
    this.domains.set(rec.applicationId, rec);
    this.apply(fx);
    return "saved" as const;
  }
  async getClaim(id: string) {
    return this.claims.get(id) ?? null;
  }
  async upsertClaim(claim: ClaimView) {
    this.claims.set(claim.applicationId, claim);
  }
  async findClaimCandidates(q: ClaimCandidateQuery) {
    return [...this.claims.values()]
      .filter((c) => c.applicationId !== q.exceptApplicationId)
      .filter((c) => c.country === q.country || (q.domain !== null && c.domain === q.domain) || (q.trademarkKey !== null && c.trademarkKey === q.trademarkKey))
      .sort((a, b) => (a.applicationId < b.applicationId ? -1 : 1))
      .slice(0, 500);
  }
  async openConflict(c: NewConflict, fx: Effects) {
    const ids = [...c.applicationIds].sort();
    const key = ids.join("|");
    const cur = this.conflicts.get(key);
    if (cur !== undefined) {
      if (cur.status === "resolved") return { conflict: cur, created: false };
      const reasons = [...new Set([...cur.reasons, ...c.reasons])].sort();
      const merged = { ...cur, reasons };
      this.conflicts.set(key, merged);
      return { conflict: merged, created: false };
    }
    const rec: ConflictRecord = {
      id: c.id, conflictKey: key, applicationIds: ids, reasons: [...new Set(c.reasons)].sort(), status: "open",
      outcome: null, winnerApplicationId: null, resolvedBy: null, resolvedAtMs: null, createdAtMs: c.createdAtMs,
    };
    this.conflicts.set(key, rec);
    this.apply(fx);
    return { conflict: rec, created: true };
  }
  async listConflictsFor(applicationId: string) {
    return [...this.conflicts.values()].filter((c) => c.applicationIds.includes(applicationId));
  }
  async resolveConflict(i: { id: string; outcome: ConflictOutcome; winnerApplicationId: string | null; resolvedBy: string; atMs: number }, fx: Effects): Promise<ResolveConflictStore> {
    const cur = [...this.conflicts.values()].find((c) => c.id === i.id);
    if (cur === undefined) return { kind: "not_found" };
    if (cur.status === "resolved") return { kind: "already_resolved", conflict: cur };
    const next: ConflictRecord = { ...cur, status: "resolved", outcome: i.outcome, winnerApplicationId: i.winnerApplicationId, resolvedBy: i.resolvedBy, resolvedAtMs: i.atMs };
    this.conflicts.set(cur.conflictKey, next);
    this.apply(fx);
    return { kind: "resolved", conflict: next };
  }
  async insertTrademarkLookup(rec: TrademarkLookupRecord, fx: Effects) {
    this.lookups.push(rec);
    this.apply(fx);
  }
  async listTrademarkLookups(applicationId: string) {
    return this.lookups.filter((l) => l.applicationId === applicationId);
  }
  async insertScreening(rec: ScreeningRecord) {
    this.screenings.push(rec);
  }
  async latestScreening(applicationId: string) {
    return [...this.screenings].reverse().find((s) => s.applicationId === applicationId) ?? null;
  }
  async insertReport(rec: ReportRecord, fx: Effects) {
    this.reports.push(rec);
    this.apply(fx);
  }
  async latestReport(applicationId: string) {
    return [...this.reports].reverse().find((r) => r.applicationId === applicationId) ?? null;
  }
}
export { orderByPriority };

// ------------------------------------------------------------------ fakes (tests and dev only)

/** DNS fake: TXT answers are set per name. No network. */
export class FakeDnsResolver implements DnsResolverPort {
  private readonly zones = new Map<string, DnsTxtResult>();
  set(name: string, answers: readonly string[]): void {
    this.zones.set(name, { kind: "ok", answers });
  }
  setError(name: string): void {
    this.zones.set(name, { kind: "error" });
  }
  async resolveTxt(name: string): Promise<DnsTxtResult> {
    return this.zones.get(name) ?? { kind: "nxdomain" };
  }
}

/**
 * HAND-AUTHORED trademark fixtures. Every field is an assumption about what a register returns;
 * no real register contract exists. VERIFY BEFORE LAUNCH (register terms, field semantics, status codes).
 */
export class FixtureTrademarkRegistry implements TrademarkRegistryPort {
  private readonly rows = new Map<string, TrademarkRegistryResult>();
  seed(office: TrademarkOffice, number: string, result: TrademarkRegistryResult): void {
    this.rows.set(`${office}:${number}`, result);
  }
  async lookup(input: { office: TrademarkOffice; number: string }): Promise<TrademarkRegistryResult> {
    return this.rows.get(`${input.office}:${input.number}`) ?? { kind: "not_found" };
  }
}

/** Tiny SYNTHETIC list: not a real sanctions list. Names containing these tokens warn or fail. VERIFY BEFORE LAUNCH. */
export class FakeSanctionsScreening implements SanctionsScreeningPort {
  async screen(input: { name: string; country: string }) {
    const n = input.name.toLowerCase();
    if (n.includes("blockedcorp")) return { outcome: "fail" as const, matchedListIds: ["SYN-0001"], listVersion: "synthetic-1" };
    if (n.includes("similarcorp")) return { outcome: "warn" as const, matchedListIds: ["SYN-0002"], listVersion: "synthetic-1" };
    return { outcome: "clear" as const, matchedListIds: [], listVersion: "synthetic-1" };
  }
}

export class FakeVerificationEmail implements VerificationEmailPort {
  readonly sent: { to: string; code: string }[] = [];
  next: "sent" | "unavailable" | "invalid_recipient" = "sent";
  async sendCode(i: { to: string; code: string }) {
    if (this.next === "sent") this.sent.push({ to: i.to, code: i.code });
    return this.next;
  }
}

export class StaticVerificationSecret implements VerificationSecretPort {
  constructor(private readonly key = "test-only-hmac-key-0123456789abcdef") {}
  hmacKey(): string {
    return this.key;
  }
}

/** The sellers module supplies the real adapter. This fake serves tests and development only. */
export class FakeApplicationOwnership implements ApplicationOwnershipPort {
  private readonly rows = new Map<string, ApplicationSnapshot>();
  seed(s: ApplicationSnapshot): void {
    this.rows.set(s.applicationId, s);
  }
  async find(applicationId: string) {
    return this.rows.get(applicationId) ?? null;
  }
}
