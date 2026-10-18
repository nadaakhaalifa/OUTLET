import type { ModuleRef } from "@nestjs/core";
import type { sellers } from "@outlet/domain";
import { BRAND_VERIFICATION, BRAND_VERIFICATION_STORE } from "../../brand-verification";
import type { ApplicationOwnershipPort, ApplicationSnapshot, BrandVerificationPort, BrandVerificationStore } from "../../brand-verification";
import { decodeView } from "../application/codec";
import type { AutoCheckSnapshot, BrandApplicationRepository, DomainVerificationState, FieldCipherPort, VerificationLink } from "../domain/ports";


/**
 * Resolves the brand-verification module's port and store at call time (module-ref, strict false), so the
 * sellers module does not import that module's providers and the two modules compose in either order. Without the
 * module (unit tests) domains are simply unverified and no checks run.
 */
export class LazyBrandVerificationLink implements VerificationLink {
  constructor(private readonly refs: ModuleRef) {}

  private port(): BrandVerificationPort | null {
    return this.refs.get<BrandVerificationPort>(BRAND_VERIFICATION, { strict: false });
  }
  private store(): BrandVerificationStore | null {
    return this.refs.get<BrandVerificationStore>(BRAND_VERIFICATION_STORE, { strict: false });
  }

  async domainState(applicationId: string): Promise<DomainVerificationState | null> {
    let store: BrandVerificationStore | null;
    try {
      store = this.store();
    } catch {
      return null;
    }
    const rec = await store?.getDomainVerification(applicationId);
    if (rec === null || rec === undefined) return null;
    return { method: rec.method, domain: rec.domain, status: rec.status, expiresAtMs: rec.expiresAtMs, verifiedAtMs: rec.verifiedAtMs };
  }

  async runAutoChecks(snapshot: AutoCheckSnapshot): Promise<void> {
    let port: BrandVerificationPort | null;
    try {
      port = this.port();
    } catch {
      return;
    }
    await port?.runAutoChecks(snapshot);
  }
}

const OFFICES: Readonly<Record<string, "WIPO" | "EUIPO" | "USPTO" | "EGYPT-IP" | "OTHER">> = {
  WIPO: "WIPO",
  EUIPO: "EUIPO",
  USPTO: "USPTO",
  EGYPT_TMO: "EGYPT-IP",
  OTHER_NATIONAL: "OTHER",
};

/** ApplicationOwnershipPort for brand-verification: the snapshot of an application, decrypted for the checks only. */
export class SellersApplicationOwnership implements ApplicationOwnershipPort {
  constructor(
    private readonly repo: BrandApplicationRepository,
    private readonly cipher: FieldCipherPort,
  ) {}

  async find(applicationId: string): Promise<ApplicationSnapshot | null> {
    const agg = await this.repo.get(applicationId, { kind: "system" });
    if (agg === null) return null;
    const v = await decodeView(this.cipher, agg.app, agg.documents);
    const r = agg.app;
    const office = r.trademarkRegister === null ? undefined : OFFICES[r.trademarkRegister];
    return {
      applicationId: r.id,
      applicantId: r.applicantId,
      kind: r.brandKind as sellers.BrandKind,
      country: r.country,
      brandName: r.brandName,
      legalName: v.pii.legalName ?? r.brandName,
      websiteDomain: r.websiteDomain,
      trademark: office !== undefined && r.trademarkNumber !== null ? { office, number: r.trademarkNumber } : null,
      submittedAtMs: r.submittedAtMs,
    };
  }
}
