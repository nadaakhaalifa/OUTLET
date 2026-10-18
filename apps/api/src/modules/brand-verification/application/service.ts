import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  DNS_CHALLENGE_TTL_MS,
  EMAIL_CHALLENGE_TTL_MS,
  aggregateAutoChecks,
  claimNameNorm,
  compareOwner,
  detectClaimConflicts,
  dnsChallengeToken,
  emailAddressFor,
  evaluateCountry,
  evaluateEmailAttempt,
  maskEmail,
  orderByPriority,
  trademarkKeyOf,
  txtContainsValue,
  txtRecordName,
  txtRecordValue,
  validateBrandDomain,
  type AutoCheck,
  type AutoCheckReport,
  type ClaimView,
  type ConflictFinding,
} from "../domain/bridge";
import type {
  ApplicationSnapshot,
  BrandVerificationPort,
  BrandVerificationStore,
  Clock,
  ConfirmDomainResult,
  ConflictDetection,
  ConflictRecord,
  DnsResolverPort,
  DomainVerificationRecord,
  DomainVerificationView,
  Effects,
  IdGenerator,
  RecordTrademarkResult,
  ResolveConflictResult,
  SanctionsScreeningPort,
  StartDomainResult,
  TrademarkEvidenceView,
  TrademarkLookupRecord,
  TrademarkRegistryPort,
  VerificationEmailPort,
  VerificationSecretPort,
} from "../domain/ports";

export interface BrandVerificationDeps {
  readonly store: BrandVerificationStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly dns: DnsResolverPort;
  readonly registry: TrademarkRegistryPort;
  readonly sanctions: SanctionsScreeningPort;
  readonly email: VerificationEmailPort;
  readonly secret: VerificationSecretPort;
}

const hmacHex = (secret: string, message: string): string => createHmac("sha256", secret).update(message).digest("hex");
const safeEqualHex = (a: string, b: string): boolean => {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
};
const EMPTY: Effects = { outbox: [], history: [] };

export class BrandVerificationService implements BrandVerificationPort {
  constructor(private readonly d: BrandVerificationDeps) {}

  // ---------------------------------------------------------------- domain verification

  private view(rec: DomainVerificationRecord, applicationId: string): DomainVerificationView {
    const base = { method: rec.method, domain: rec.domain, status: rec.status, expiresAtMs: rec.expiresAtMs, verifiedAtMs: rec.verifiedAtMs };
    if (rec.method === "dns_txt") {
      const token = dnsChallengeToken(hmacHex, this.d.secret.hmacKey(), applicationId, rec.domain, rec.nonce);
      return { ...base, txtRecordName: txtRecordName(rec.domain), txtRecordValue: txtRecordValue(token) };
    }
    return { ...base, ...(rec.emailLocal !== null ? { emailSentToMasked: maskEmail(rec.emailLocal, rec.domain) } : {}) };
  }

  private codeHash(applicationId: string, code: string): string {
    return hmacHex(this.d.secret.hmacKey(), `email-code|${applicationId}|${code}`);
  }

  async startDomainVerification(i: Parameters<BrandVerificationPort["startDomainVerification"]>[0]): Promise<StartDomainResult> {
    const { snapshot } = i;
    const check = validateBrandDomain(i.rawDomain);
    if (!check.ok) return { kind: "invalid_domain", reason: check.reason };
    if (i.method === "email" && i.emailLocalPart === undefined) return { kind: "invalid_domain", reason: "email_local_part_required" };
    const now = this.d.clock.nowMs();
    const existing = await this.d.store.getDomainVerification(snapshot.applicationId);
    if (existing !== null && existing.domain === check.domain && existing.method === i.method) {
      if (existing.status === "verified") return { kind: "started", verification: this.view(existing, snapshot.applicationId) };
      if (existing.status === "pending" && now < existing.expiresAtMs && (i.method === "dns_txt" || existing.emailLocal === i.emailLocalPart)) {
        await this.registerClaim(snapshot, check.domain, null);
        return { kind: "started", verification: this.view(existing, snapshot.applicationId) };
      }
    }
    // An application proves one domain at a time; a new start replaces the previous attempt.
    const nonce = this.d.ids.hex(16);
    let code: string | null = null;
    if (i.method === "email" && i.emailLocalPart !== undefined) {
      code = String(Number.parseInt(this.d.ids.hex(6), 16) % 1_000_000).padStart(6, "0");
      const sent = await this.d.email.sendCode({ to: emailAddressFor(i.emailLocalPart, check.domain), code, requestId: this.d.ids.uuidV7() });
      if (sent !== "sent") return { kind: "email_unavailable" };
    }
    const rec: DomainVerificationRecord = {
      applicationId: snapshot.applicationId,
      applicantId: snapshot.applicantId,
      domain: check.domain,
      method: i.method,
      status: "pending",
      nonce,
      emailLocal: i.method === "email" ? (i.emailLocalPart ?? null) : null,
      emailCodeHash: code === null ? null : this.codeHash(snapshot.applicationId, code),
      attempts: 0,
      expiresAtMs: now + (i.method === "dns_txt" ? DNS_CHALLENGE_TTL_MS : EMAIL_CHALLENGE_TTL_MS),
      verifiedAtMs: null,
      version: existing === null ? 0 : existing.version + 1,
      createdAtMs: now,
      updatedAtMs: now,
    };
    const saved = await this.d.store.saveDomainVerification(rec, existing === null ? null : existing.version, {
      outbox: [{ aggregateId: snapshot.applicationId, eventType: "brand_domain.verification_started", payload: { application_id: snapshot.applicationId, method: i.method } }],
      history: [{ applicationId: snapshot.applicationId, actorId: snapshot.applicantId, action: "domain.started", refId: null }],
    });
    if (saved === "version_conflict") return { kind: "conflict" };
    // A domain someone else already claimed or verified looks exactly like a fresh pending claim to this caller.
    await this.registerClaim(snapshot, check.domain, null);
    return { kind: "started", verification: this.view(rec, snapshot.applicationId) };
  }

  async confirmDomainVerification(i: Parameters<BrandVerificationPort["confirmDomainVerification"]>[0]): Promise<ConfirmDomainResult> {
    const { snapshot } = i;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const rec = await this.d.store.getDomainVerification(snapshot.applicationId);
      if (rec === null) return { kind: "not_started" };
      const view = (r: DomainVerificationRecord): DomainVerificationView => this.view(r, snapshot.applicationId);
      if (rec.status === "verified") return { kind: "confirmed", verification: view(rec) };
      const now = this.d.clock.nowMs();
      const persist = async (next: DomainVerificationRecord, fx: Effects): Promise<boolean> =>
        (await this.d.store.saveDomainVerification({ ...next, version: rec.version + 1, updatedAtMs: now }, rec.version, fx)) === "saved";
      if (rec.status === "failed") return { kind: "locked" };
      if (rec.status === "expired" || now >= rec.expiresAtMs) {
        if (rec.status === "pending" && !(await persist({ ...rec, status: "expired" }, EMPTY))) continue;
        return { kind: "expired" };
      }
      const verifiedFx: Effects = {
        outbox: [{ aggregateId: snapshot.applicationId, eventType: "brand_domain.verified", payload: { application_id: snapshot.applicationId, method: rec.method } }],
        history: [{ applicationId: snapshot.applicationId, actorId: snapshot.applicantId, action: "domain.verified", refId: null }],
      };
      if (rec.method === "dns_txt") {
        const token = dnsChallengeToken(hmacHex, this.d.secret.hmacKey(), snapshot.applicationId, rec.domain, rec.nonce);
        const r = await this.d.dns.resolveTxt(txtRecordName(rec.domain));
        if (!(r.kind === "ok" && txtContainsValue(r.answers, txtRecordValue(token)))) return { kind: "pending", verification: view(rec) };
      } else {
        if (i.code === undefined) return { kind: "code_required" };
        const matches = rec.emailCodeHash !== null && safeEqualHex(this.codeHash(snapshot.applicationId, i.code), rec.emailCodeHash);
        const out = evaluateEmailAttempt({ status: rec.status, expiresAtMs: rec.expiresAtMs, attempts: rec.attempts }, now, matches);
        if (out.kind === "expired") return { kind: "expired" };
        if (out.kind === "not_pending") return { kind: "locked" };
        if (out.kind === "locked") {
          // Persist the lock; a locked challenge must be restarted (which re-sends a new code).
          if (!(await persist({ ...rec, attempts: out.attempts, status: "failed" }, EMPTY))) continue;
          return { kind: "locked" };
        }
        if (out.kind === "wrong_code") {
          if (!(await persist({ ...rec, attempts: out.attempts }, EMPTY))) continue;
          return { kind: "wrong_code", attemptsRemaining: out.attemptsRemaining };
        }
        const next: DomainVerificationRecord = { ...rec, attempts: out.attempts, status: "verified", verifiedAtMs: now, emailCodeHash: null };
        if (!(await persist(next, verifiedFx))) continue;
        await this.registerClaim(snapshot, rec.domain, now);
        return { kind: "confirmed", verification: view({ ...next, version: rec.version + 1 }) };
      }
      const next: DomainVerificationRecord = { ...rec, status: "verified", verifiedAtMs: now };
      if (!(await persist(next, verifiedFx))) continue;
      await this.registerClaim(snapshot, rec.domain, now);
      return { kind: "confirmed", verification: view({ ...next, version: rec.version + 1 }) };
    }
    return { kind: "conflict" };
  }

  // ---------------------------------------------------------------- claims and conflicts

  private claimOf(snapshot: ApplicationSnapshot, prior: ClaimView | null, patch: Partial<ClaimView>): ClaimView {
    return {
      applicationId: snapshot.applicationId,
      applicantId: snapshot.applicantId,
      kind: snapshot.kind,
      country: snapshot.country.toUpperCase(),
      brandNameNorm: claimNameNorm(snapshot.brandName),
      domain: prior?.domain ?? null,
      trademarkKey: prior?.trademarkKey ?? (snapshot.trademark === null ? null : trademarkKeyOf(snapshot.trademark.office, snapshot.trademark.number)),
      domainVerifiedAtMs: prior?.domainVerifiedAtMs ?? null,
      trademarkMatchedAtMs: prior?.trademarkMatchedAtMs ?? null,
      submittedAtMs: snapshot.submittedAtMs ?? prior?.submittedAtMs ?? null,
      ...patch,
    };
  }

  private async registerClaim(snapshot: ApplicationSnapshot, domain: string | null, domainVerifiedAtMs: number | null): Promise<void> {
    const prior = await this.d.store.getClaim(snapshot.applicationId);
    const changed = domain !== null && prior?.domain !== domain;
    await this.d.store.upsertClaim(
      this.claimOf(snapshot, prior, {
        ...(domain !== null ? { domain } : {}),
        domainVerifiedAtMs: domainVerifiedAtMs ?? (changed ? null : (prior?.domainVerifiedAtMs ?? null)),
      }),
    );
    await this.openConflictsFor(snapshot);
  }

  private async findings(snapshot: ApplicationSnapshot): Promise<{ claim: ClaimView; findings: readonly ConflictFinding[]; others: readonly ClaimView[] }> {
    const prior = await this.d.store.getClaim(snapshot.applicationId);
    const claim = this.claimOf(snapshot, prior, {});
    const others = await this.d.store.findClaimCandidates({
      exceptApplicationId: claim.applicationId,
      country: claim.country,
      domain: claim.domain,
      trademarkKey: claim.trademarkKey,
    });
    return { claim, findings: detectClaimConflicts(claim, others), others };
  }

  /** Opens (idempotently) one conflict per pair; never visible to the applicants, only to trust_safety. */
  private async openConflictsFor(snapshot: ApplicationSnapshot): Promise<readonly ConflictRecord[]> {
    const { claim, findings } = await this.findings(snapshot);
    const out: ConflictRecord[] = [];
    for (const f of findings) {
      const id = this.d.ids.uuidV7();
      const r = await this.d.store.openConflict(
        { id, applicationIds: [claim.applicationId, f.otherApplicationId], reasons: f.reasons, createdAtMs: this.d.clock.nowMs() },
        {
          outbox: [{ aggregateId: id, eventType: "brand_claim_conflict.opened", payload: { conflict_id: id, application_ids: [claim.applicationId, f.otherApplicationId] } }],
          history: [{ applicationId: claim.applicationId, actorId: null, action: "conflict.opened", refId: id }],
        },
      );
      out.push(r.conflict);
    }
    return out;
  }

  async detectConflicts(snapshot: ApplicationSnapshot): Promise<ConflictDetection> {
    const prior = await this.d.store.getClaim(snapshot.applicationId);
    if (prior === null) await this.d.store.upsertClaim(this.claimOf(snapshot, null, {}));
    const opened = await this.openConflictsFor(snapshot);
    const open = (await this.d.store.listConflictsFor(snapshot.applicationId)).filter((c) => c.status === "open");
    const merged = new Map([...open, ...opened.filter((c) => c.status === "open")].map((c) => [c.id, c]));
    const { claim, others } = await this.findings(snapshot);
    const inConflict = new Set([...merged.values()].flatMap((c) => c.applicationIds));
    const ranked = orderByPriority([claim, ...others.filter((o) => inConflict.has(o.applicationId))]);
    const idx = ranked.findIndex((c) => c.applicationId === claim.applicationId);
    return { conflicts: [...merged.values()].sort((a, b) => (a.id < b.id ? -1 : 1)), priorityRank: merged.size === 0 || idx < 0 ? null : idx + 1 };
  }

  async resolveConflict(i: Parameters<BrandVerificationPort["resolveConflict"]>[0]): Promise<ResolveConflictResult> {
    const conflicts = [...(await this.d.store.listConflictsFor(i.applicationId))].sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : 1));
    const target = conflicts.find((c) => c.status === "open") ?? conflicts[conflicts.length - 1];
    if (target === undefined) return { kind: "not_found" };
    if (target.status === "resolved") {
      return target.outcome === i.outcome ? { kind: "replayed", conflict: target } : { kind: "already_resolved_differently", conflict: target };
    }
    const claims = (await Promise.all(target.applicationIds.map((id) => this.d.store.getClaim(id)))).filter((c): c is ClaimView => c !== null);
    const first = orderByPriority(claims)[0]?.applicationId ?? null;
    const winner = i.outcome === "keep_first" ? first : i.outcome === "replace_with_this" ? i.applicationId : null;
    const r = await this.d.store.resolveConflict(
      { id: target.id, outcome: i.outcome, winnerApplicationId: winner, resolvedBy: i.actorId, atMs: this.d.clock.nowMs() },
      {
        outbox: [{ aggregateId: target.id, eventType: "brand_claim_conflict.resolved", payload: { conflict_id: target.id, outcome: i.outcome, winner_application_id: winner, note_sha256: sha256Hex(i.internalNote) } }],
        history: target.applicationIds.map((applicationId) => ({ applicationId, actorId: i.actorId, action: "conflict.resolved", refId: target.id })),
      },
    );
    if (r.kind === "not_found") return { kind: "not_found" };
    if (r.kind === "already_resolved") return r.conflict.outcome === i.outcome ? { kind: "replayed", conflict: r.conflict } : { kind: "already_resolved_differently", conflict: r.conflict };
    return { kind: "resolved", conflict: r.conflict };
  }

  // ---------------------------------------------------------------- trademark

  private evidenceView(r: TrademarkLookupRecord): TrademarkEvidenceView {
    return {
      id: r.id,
      source: r.source,
      office: r.office,
      registerNumber: r.registerNumber,
      found: r.found,
      ownerName: r.ownerName,
      status: r.status,
      classes: r.classes,
      ownerMatchesApplicant: r.ownerBand === null ? "unknown" : r.ownerBand === "match" ? "yes" : "no",
      ownerScore: r.ownerScore,
      retrievedAtMs: r.retrievedAtMs,
    };
  }

  async recordTrademarkLookup(i: Parameters<BrandVerificationPort["recordTrademarkLookup"]>[0]): Promise<RecordTrademarkResult> {
    const { snapshot } = i;
    const now = this.d.clock.nowMs();
    const base = { id: this.d.ids.uuidV7(), applicationId: snapshot.applicationId, recordedBy: i.actorId, retrievedAtMs: now, createdAtMs: now };
    let rec: TrademarkLookupRecord;
    if (i.mode === "manual") {
      const m = i.manual;
      if (m === undefined) return { kind: "no_trademark_claimed" };
      const band = m.found && m.ownerName !== undefined ? compareOwner(snapshot.legalName, m.ownerName) : null;
      rec = {
        ...base, source: "manual", office: m.office, registerNumber: m.registerNumber, found: m.found,
        ownerName: m.ownerName ?? null, markText: m.markText ?? null, classes: m.classes ?? [], status: m.status ?? null,
        registeredOn: null, expiresOn: null, ownerScore: band?.score ?? null, ownerBand: band?.band ?? null,
      };
    } else {
      if (snapshot.trademark === null) return { kind: "no_trademark_claimed" };
      const r = await this.d.registry.lookup(snapshot.trademark); // Unconfigured adapter throws 503 here (fail closed)
      const band = r.kind === "found" ? compareOwner(snapshot.legalName, r.record.ownerName) : null;
      rec = {
        ...base, source: "registry", office: snapshot.trademark.office, registerNumber: snapshot.trademark.number, found: r.kind === "found",
        ownerName: r.kind === "found" ? r.record.ownerName : null, markText: r.kind === "found" ? r.record.markText : null,
        classes: r.kind === "found" ? r.record.classes : [], status: r.kind === "found" ? r.record.status : null,
        registeredOn: r.kind === "found" ? r.record.registeredOn : null, expiresOn: r.kind === "found" ? r.record.expiresOn : null,
        ownerScore: band?.score ?? null, ownerBand: band?.band ?? null,
      };
    }
    await this.d.store.insertTrademarkLookup(rec, {
      outbox: [{ aggregateId: snapshot.applicationId, eventType: "brand_trademark.lookup_recorded", payload: { application_id: snapshot.applicationId, lookup_id: rec.id, found: rec.found, owner_band: rec.ownerBand } }],
      history: [{ applicationId: snapshot.applicationId, actorId: i.actorId, action: "trademark.lookup", refId: rec.id }],
    });
    if (rec.found && rec.ownerBand === "match") {
      const prior = await this.d.store.getClaim(snapshot.applicationId);
      await this.d.store.upsertClaim(
        this.claimOf(snapshot, prior, { trademarkKey: trademarkKeyOf(rec.office, rec.registerNumber), trademarkMatchedAtMs: prior?.trademarkMatchedAtMs ?? now }),
      );
      await this.openConflictsFor(snapshot);
    }
    return { kind: "recorded", evidence: this.evidenceView(rec) };
  }

  // ---------------------------------------------------------------- auto checks

  async runAutoChecks(snapshot: ApplicationSnapshot): Promise<AutoCheckReport> {
    const now = this.d.clock.nowMs();
    const checks: AutoCheck[] = [];

    const country = evaluateCountry(snapshot.kind, snapshot.country);
    checks.push({ code: "country_policy", result: country === "allowed" ? "pass" : "fail", reasons: country === "allowed" ? [] : [country], evidenceIds: [] });

    const dv = await this.d.store.getDomainVerification(snapshot.applicationId);
    const claimedDomain = snapshot.websiteDomain === null ? null : validateBrandDomain(snapshot.websiteDomain);
    const domainOk = dv !== null && dv.status === "verified" && (claimedDomain === null || (claimedDomain.ok && claimedDomain.domain === dv.domain));
    checks.push(
      domainOk
        ? { code: "domain_verified", result: "pass", reasons: [], evidenceIds: [] }
        : dv === null && snapshot.websiteDomain === null && snapshot.kind === "local"
          ? { code: "domain_verified", result: "skipped", reasons: ["no_website_claimed"], evidenceIds: [] }
          : { code: "domain_verified", result: snapshot.kind === "global" ? "fail" : "warn", reasons: [dv === null ? "not_started" : dv.status === "verified" ? "domain_mismatch" : "not_verified"], evidenceIds: [] },
    );

    if (snapshot.trademark === null) {
      checks.push({ code: "trademark_owner", result: "skipped", reasons: ["no_trademark_claimed"], evidenceIds: [] });
    } else {
      try {
        const r = await this.recordTrademarkLookup({ snapshot, mode: "auto", actorId: null });
        if (r.kind === "recorded") {
          const e = r.evidence;
          const result = !e.found ? "warn" : e.ownerMatchesApplicant === "yes" ? "pass" : (e.ownerScore ?? 0) >= 60 ? "warn" : "fail";
          checks.push({ code: "trademark_owner", result, reasons: [!e.found ? "trademark_not_found" : e.ownerMatchesApplicant === "yes" ? "owner_match" : "owner_differs"], evidenceIds: [e.id] });
        }
      } catch {
        checks.push({ code: "trademark_owner", result: "error", reasons: ["registry_unavailable"], evidenceIds: [] });
      }
    }

    try {
      const s = await this.d.sanctions.screen({ name: snapshot.legalName, country: snapshot.country });
      const rec = { id: this.d.ids.uuidV7(), applicationId: snapshot.applicationId, outcome: s.outcome, matchedListIds: s.matchedListIds, listVersion: s.listVersion, screenedAtMs: now };
      await this.d.store.insertScreening(rec);
      checks.push({ code: "sanctions", result: s.outcome === "clear" ? "pass" : s.outcome === "warn" ? "warn" : "fail", reasons: s.outcome === "clear" ? [] : [`sanctions_${s.outcome}`], evidenceIds: [rec.id] });
    } catch {
      checks.push({ code: "sanctions", result: "error", reasons: ["screening_unavailable"], evidenceIds: [] });
    }

    const det = await this.detectConflicts(snapshot);
    const open = det.conflicts.filter((c) => c.status === "open");
    checks.push({ code: "duplicate_claim", result: open.length > 0 ? "warn" : "pass", reasons: open.length > 0 ? ["duplicate_claim"] : [], evidenceIds: open.map((c) => c.id) });

    const report = aggregateAutoChecks({ applicationId: snapshot.applicationId, kind: snapshot.kind, country: snapshot.country, ranAtMs: now, checks });
    const id = this.d.ids.uuidV7();
    await this.d.store.insertReport(
      { id, applicationId: snapshot.applicationId, report, createdAtMs: now },
      {
        outbox: [{ aggregateId: snapshot.applicationId, eventType: "brand_verification.checks_completed", payload: { application_id: snapshot.applicationId, report_id: id, risk: report.risk, dual_approval_required: report.dualApprovalRequired } }],
        history: [{ applicationId: snapshot.applicationId, actorId: null, action: "checks.completed", refId: id }],
      },
    );
    return report;
  }
}

export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");
