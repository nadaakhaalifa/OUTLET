/** BrandApplyPort over the generated client (sellerBearer). Seller tokens live in memory only: a restart signs the brand back in. */
import {
  ApiError, ContractDriftError, NetworkError, TimeoutError, createClient, dataOf, type OutletClient, type schemas,
} from "../../services/api-client";
import type { ApiRuntime } from "../../services/runtime";
import { sha256Hex } from "./sha256";
import { fromWireValues, toWirePatch } from "./wire-map";
import {
  BrandApplyError, wireContentType,
  type AllowedAction, type ApplicationPatch, type ApplicationView, type BrandApplyPort, type BrandKind, type DocView, type DomainState,
  type ErrorCode, type FileType, type OtpChallenge, type PasskeyChallenge, type ReqDoc, type ReqField, type Requirements, type TotpEnrolment, type UploadRequest,
} from "./model";

const PROBLEM: Readonly<Record<string, ErrorCode>> = {
  strong_factor_required: "strong_factor_required", checklist_incomplete: "checklist_incomplete", reapply_cooldown: "reapply_cooldown",
  country_not_supported: "country_not_supported", invalid_transition: "invalid_transition",
};

export function toBrandError(e: unknown): BrandApplyError {
  if (e instanceof BrandApplyError) return e;
  if (e instanceof NetworkError || e instanceof TimeoutError) return new BrandApplyError("offline");
  if (e instanceof ApiError) {
    const byCode = e.code !== undefined ? PROBLEM[e.code] : undefined;
    if (byCode !== undefined) return new BrandApplyError(byCode);
    if (e.status === 401) return new BrandApplyError("session_expired");
    if (e.status === 404) return new BrandApplyError("not_found");
    if (e.status === 409) return new BrandApplyError("conflict");
    if (e.status === 429) return new BrandApplyError("rate_limited");
    if (e.status === 422 || e.status === 400) return new BrandApplyError("invalid_code");
  }
  if (e instanceof ContractDriftError) return new BrandApplyError("failed", "contract_drift");
  return new BrandApplyError("failed");
}

const bi = (ar: string, en: string) => ({ ar, en });
const FILE: Readonly<Record<string, FileType>> = { pdf: "pdf", jpg: "jpg", png: "png" };

export function mapRequirements(r: schemas.BrandRequirements): Requirements {
  const fields = r.fields.map((f): ReqField => ({
    code: f.code, label: bi(f.label_ar, f.label_en), required: f.required, format: f.format, pattern: f.pattern, minSignatoryAge: f.min_signatory_age,
  }));
  const documents = r.documents.map((d): ReqDoc => ({
    code: d.code, label: bi(d.label_ar, d.label_en), required: d.required, group: d.one_of_group,
    accepts: d.accepts.map((a) => FILE[a] ?? "pdf"), maxBytes: d.max_bytes ?? 10 * 1024 * 1024,
    help: d.help_ar !== undefined || d.help_en !== undefined ? bi(d.help_ar ?? d.help_en ?? "", d.help_en ?? d.help_ar ?? "") : undefined,
  }));
  return { kind: r.kind, country: r.country, version: r.version, fields, documents, websiteVerification: r.website_verification };
}

export function mapDocument(d: schemas.BrandDocument): DocView {
  return {
    id: d.id, requirementCode: d.requirement_code, contentType: d.content_type, sizeBytes: d.size_bytes, uploadStatus: d.upload_status,
    scanStatus: d.scan_status, reviewStatus: d.review_status, reviewNote: d.review_note_public ?? undefined,
  };
}
export function mapDomain(d: schemas.DomainVerification): DomainState {
  return { method: d.method, domain: d.domain, status: d.status, txtName: d.txt_record_name, txtValue: d.txt_record_value, emailMasked: d.email_sent_to_masked, expiresAt: d.expires_at };
}
export function mapApplication(a: schemas.BrandApplication, version: string | null): ApplicationView {
  const values = fromWireValues(a as unknown as Record<string, unknown>);
  return {
    id: a.id, status: a.status === "PROVISIONING_FAILED" ? "APPROVED" : a.status, kind: a.brand_kind, country: a.country, brandName: a.brand_name, values,
    ownershipBasis: a.ownership_basis, documents: a.documents.map(mapDocument),
    requestedItems: a.requested_items.map((i) => ({ code: i.code, kind: i.kind, message: bi(i.message_ar, i.message_en), satisfied: i.satisfied ?? false })),
    decision: a.decision === null || a.decision === undefined ? null : {
      decision: a.decision.decision, reasonCode: a.decision.reason_code, message: bi(a.decision.message_ar, a.decision.message_en),
      decidedAt: a.decision.decided_at, reapplyAfter: a.decision.reapply_after ?? null, appealAllowed: a.decision.appeal_allowed ?? false,
    },
    decisionDueAt: a.decision_due_at ?? null, domain: a.domain_verification === undefined ? null : mapDomain(a.domain_verification),
    allowedActions: a.allowed_actions as readonly AllowedAction[], appealUsed: a.appeal_used ?? false, submittedAt: a.submitted_at ?? null,
    storeId: a.store_id ?? null, version,
  };
}

interface SellerSession { access: string; refresh: string | null; enrol: boolean }

/** PUT with upload progress. XHR is used because fetch has no upload progress in React Native. */
function putWithProgress(url: string, headers: Readonly<Record<string, string>>, body: Blob, onProgress: (r: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new BrandApplyError(xhr.status === 403 ? "conflict" : "failed")));
    xhr.onerror = () => reject(new BrandApplyError("offline"));
    xhr.ontimeout = () => reject(new BrandApplyError("offline"));
    xhr.timeout = 60_000;
    xhr.send(body);
  });
}

export class ApiBrandApplyPort implements BrandApplyPort {
  private session: SellerSession | null = null;
  private otpProof: string | null = null;
  private readonly etags = new Map<string, string>();
  private readonly client: OutletClient;

  constructor(private readonly rt: ApiRuntime) {
    const common = {
      baseUrl: rt.baseUrl,
      ...(rt.fetch !== undefined ? { fetch: rt.fetch } : {}),
      getHeaders: async (): Promise<Record<string, string>> => {
        const h: Record<string, string> = { "X-Client-Platform": rt.platform, "Accept-Language": rt.locale() === "en" ? "en" : "ar-EG" };
        const a = rt.attest !== undefined ? await rt.attest() : null;
        if (a !== null) h["X-App-Attest"] = a;
        return h;
      },
    };
    const bare = createClient({ ...common, getToken: async () => null });
    this.client = createClient({
      ...common,
      getToken: () => this.session?.access ?? null,
      refreshToken: async () => {
        const s = this.session;
        if (s === null || s.refresh === null) return null;
        try {
          const r = await bare.refreshSession({ body: { refresh_token: s.refresh, device_install_id: await rt.installId() } });
          if (r.notModified) return null;
          this.session = { ...s, access: r.data.access_token, refresh: r.data.refresh_token };
          return r.data.access_token;
        } catch { this.session = null; return null; }
      },
    });
  }

  private async run<T>(f: () => Promise<T>): Promise<T> {
    try { return await f(); } catch (e) { throw toBrandError(e); }
  }
  private take(a: schemas.BrandApplication, etag: string | null): ApplicationView {
    if (etag !== null) this.etags.set(a.id, etag);
    return mapApplication(a, etag ?? this.etags.get(a.id) ?? null);
  }
  private setFull(s: schemas.SellerSession): void {
    this.session = { access: s.access_token, refresh: s.refresh_token, enrol: false };
  }

  requestOtp(i: { phone: string; email: string; locale: "ar" | "en" }): Promise<OtpChallenge> {
    return this.run(async () => {
      const c = dataOf(await this.client.requestSellerOtp({ body: { phone_e164: i.phone, email: i.email, locale: i.locale } }));
      return { challengeId: c.challenge_id, expiresIn: c.expires_in, resendAfter: c.resend_after };
    });
  }
  verifyOtp(i: { challengeId: string; code: string }): Promise<{ strongFactorEnrolled: boolean }> {
    return this.run(async () => {
      const t = dataOf(await this.client.verifySellerOtp({ body: { challenge_id: i.challengeId, code: i.code } }));
      this.session = { access: t.enrol_token, refresh: null, enrol: true };
      this.otpProof = t.otp_proof ?? null;
      return { strongFactorEnrolled: t.strong_factor_enrolled };
    });
  }
  getRequirements(kind: BrandKind, country: string): Promise<Requirements> {
    return this.run(async () => mapRequirements(dataOf(await this.client.getBrandRequirements({ query: { kind, country } }))));
  }
  passkeyOptions(): Promise<PasskeyChallenge> {
    return this.run(async () => {
      const o = dataOf(await this.client.sellerPasskeyRegisterOptions({}));
      return { challengeId: o.challenge_id, publicKey: o.public_key };
    });
  }
  passkeyRegister(i: { challengeId: string; credential: Readonly<Record<string, unknown>> }): Promise<void> {
    return this.run(async () => this.setFull(dataOf(await this.client.sellerPasskeyRegister({ body: { challenge_id: i.challengeId, credential: { ...i.credential } } }))));
  }
  totpEnrol(): Promise<TotpEnrolment> {
    return this.run(async () => {
      const e = dataOf(await this.client.sellerTotpEnrol({}));
      const secret = new URL(e.otpauth_uri.replace("otpauth://", "https://")).searchParams.get("secret") ?? "";
      return { otpauthUri: e.otpauth_uri, secret, recoveryCodes: e.recovery_codes };
    });
  }
  totpConfirm(code: string): Promise<void> {
    return this.run(async () => this.setFull(dataOf(await this.client.sellerTotpConfirm({ body: { code } }))));
  }
  totpAssert(code: string): Promise<void> {
    return this.run(async () => {
      if (this.otpProof === null) throw new BrandApplyError("session_expired");
      this.setFull(dataOf(await this.client.sellerTotpAssert({ body: { otp_proof: this.otpProof, code } })));
    });
  }

  createApplication(i: { kind: BrandKind; country: string; brandName: string }): Promise<ApplicationView> {
    return this.run(async () => {
      const r = await this.client.createBrandApplication({ body: { brand_kind: i.kind, country: i.country, brand_name: i.brandName } });
      return this.take(dataOf(r), r.etag);
    });
  }
  getApplication(id: string): Promise<ApplicationView> {
    return this.run(async () => { const r = await this.client.getBrandApplication({ path: { id } }); return this.take(dataOf(r), r.etag); });
  }
  listMine(): Promise<readonly ApplicationView[]> {
    return this.run(async () => dataOf(await this.client.listMyBrandApplications({})).items.map((a) => mapApplication(a, null)));
  }
  updateApplication(id: string, patch: ApplicationPatch, version: string | null): Promise<ApplicationView> {
    return this.run(async () => {
      const etag = version ?? this.etags.get(id) ?? (await this.getApplication(id)).version ?? "*";
      const body = toWirePatch(patch) as schemas.BrandApplicationUpdate;
      const r = await this.client.updateBrandApplication({ path: { id }, headers: { "If-Match": etag }, body });
      return this.take(dataOf(r), r.etag);
    });
  }

  uploadDocument(id: string, req: UploadRequest, onProgress: (r: number) => void): Promise<DocView> {
    return this.run(async () => {
      const blob = await (await fetch(req.uri)).blob();
      const sha = sha256Hex(new Uint8Array(await blob.arrayBuffer()));
      const grant = dataOf(await this.client.createBrandApplicationDocument({
        path: { id }, body: { requirement_code: req.requirementCode, content_type: wireContentType(req.contentType), size_bytes: blob.size, sha256: sha },
      }));
      // The signed URL must be https; the only exception is a local dev server.
      if (!grant.upload_url.startsWith("https://") && !(typeof __DEV__ !== "undefined" && __DEV__)) throw new BrandApplyError("failed");
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await putWithProgress(grant.upload_url, grant.upload_headers, blob, onProgress); lastError = null; break; } catch (e) { lastError = e; }
      }
      if (lastError !== null) throw lastError;
      return mapDocument(dataOf(await this.client.confirmBrandApplicationDocument({ path: { id, document_id: grant.document_id }, body: {} })));
    });
  }
  deleteDocument(id: string, docId: string): Promise<void> {
    return this.run(async () => { await this.client.deleteBrandApplicationDocument({ path: { id, document_id: docId } }); });
  }
  startDomain(id: string, method: "dns_txt" | "email"): Promise<DomainState> {
    return this.run(async () => mapDomain(dataOf(await this.client.startBrandDomainVerification({ path: { id }, body: { method } }))));
  }
  confirmDomain(id: string, code?: string): Promise<DomainState> {
    return this.run(async () => mapDomain(dataOf(await this.client.confirmBrandDomainVerification({ path: { id }, body: code !== undefined ? { code } : {} }))));
  }
  submit(id: string): Promise<ApplicationView> {
    return this.run(async () => { const r = await this.client.submitBrandApplication({ path: { id } }); return this.take(dataOf(r), r.etag); });
  }
  resubmit(id: string, i: { note?: string; satisfiedCodes: readonly string[] }): Promise<ApplicationView> {
    return this.run(async () => {
      const r = await this.client.resubmitBrandApplication({ path: { id }, body: { satisfied_item_codes: [...i.satisfiedCodes], ...(i.note !== undefined ? { note: i.note } : {}) } });
      return this.take(dataOf(r), r.etag);
    });
  }
  appeal(id: string, statement: string): Promise<ApplicationView> {
    return this.run(async () => { const r = await this.client.appealBrandApplication({ path: { id }, body: { statement } }); return this.take(dataOf(r), r.etag); });
  }
  withdraw(id: string): Promise<ApplicationView> {
    return this.run(async () => { const r = await this.client.withdrawBrandApplication({ path: { id } }); return this.take(dataOf(r), r.etag); });
  }
}
