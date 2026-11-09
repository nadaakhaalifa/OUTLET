import type { MultipartFile } from "@fastify/multipart";
import { Controller, Get, HttpCode, Inject, Post, Put, Req } from "@nestjs/common";
import type { Principal } from "@outlet/policy";
import { REQUIRED_DOCUMENTS } from "@outlet/seller-accounts";
import { z } from "zod";
import { Authorize, Contract, RateLimit } from "../../platform/decorators.js";
import { API_DEPS } from "../../platform/deps.js";
import type { ApiDeps } from "../../platform/deps.js";
import type { ApiRequest, RequestState } from "../../platform/http.js";
import { Problems } from "../../platform/problem.js";
import { RATE_BUDGETS } from "../../platform/rate-limit/budgets.js";
import { SELLER_ONBOARDING_BUDGET } from "./budget.js";
import { self } from "../../platform/resolvers.js";
import { Body, Ctx } from "../../platform/validation.js";
import { BankAccountInput, BankAccountResult, DocumentUploadForm, DocumentUploadResult, EmptyBody, SellerOnboarding, SellerOnboardingInput, SellerOnboardingResult } from "./dto.js";
import type { SellerOnboardingServices } from "./services.js";

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
/** Any authenticated login acts on its own application; the policy has no seller.onboard action yet, so the neutral own-account action is used (see the module README). */
const OWN_ACCOUNT = "seller.onboard";
const STRONG_AMR = new Set(["passkey", "hwk"]);

interface Own { readonly userId: string; readonly marketId: string; readonly svc: SellerOnboardingServices }

/**
 * Seller application by the applicant (user tenant, not store: the store does not exist before approval). Phishing-resistant session
 * required (DM-09). KYC fields are P3: the IBAN is encrypted by the package, never echoed and never logged.
 */
@Controller("v1/:market/seller/onboarding")
export class SellerOnboardingController {
  constructor(@Inject(API_DEPS) private readonly deps: ApiDeps) {}

  private own(s: RequestState): Own {
    if (s.user === undefined) throw Problems.unauthenticated();
    if (s.marketId === undefined) throw Problems.notFound("unknown-market");
    if (!s.user.amr.some((a) => STRONG_AMR.has(a))) throw Problems.forbidden("passkey-required");
    return { userId: s.user.userId, marketId: s.marketId, svc: this.deps.sellerOnboarding(s.marketId) };
  }

  private async sellerId(o: Own): Promise<string> {
    const id = await o.svc.lookup.sellerOf(o.userId);
    if (id === null) throw Problems.notFound();
    return id;
  }

  @Post()
  @HttpCode(201)
  @Authorize(OWN_ACCOUNT, self)
  @RateLimit({ budget: SELLER_ONBOARDING_BUDGET })
  @Contract({ operationId: "startSellerOnboarding", summary: "Start a seller application (seller entity + KYC case in DRAFT; the caller is the applicant)", tags: ["Seller KYC"], body: SellerOnboardingInput, response: SellerOnboardingResult, status: 201, maxQueries: 8 })
  async start(@Ctx() s: RequestState, @Body() b: z.infer<typeof SellerOnboardingInput>): Promise<SellerOnboardingResult> {
    const o = this.own(s);
    const r = await o.svc.onboarding.createDraft(o.userId, b);
    return { seller_id: r.sellerId, kyc_case_id: r.caseId };
  }

  @Get()
  @Authorize(OWN_ACCOUNT, self)
  @RateLimit({ budget: RATE_BUDGETS.shopperRead })
  @Contract({ operationId: "getSellerOnboarding", summary: "My application: KYC state and what still blocks submission", tags: ["Seller KYC"], response: SellerOnboarding, maxQueries: 8 })
  async get(@Ctx() s: RequestState): Promise<SellerOnboarding> {
    const o = this.own(s);
    const c = await o.svc.onboarding.getCase(o.userId, await this.sellerId(o));
    return {
      seller_id: c.sellerId, kyc_case_id: c.caseId, status: c.state, submitted_at: c.submittedAt, decided_at: c.decidedAt, decision_reason: c.reasonCode, version: c.version,
      gaps: [...c.gaps], required_documents: [...REQUIRED_DOCUMENTS],
    };
  }

  @Post("documents")
  @HttpCode(201)
  @Authorize(OWN_ACCOUNT, self)
  @RateLimit({ budget: SELLER_ONBOARDING_BUDGET })
  @Contract({
    operationId: "uploadOnboardingDocument",
    summary: "Upload one KYC document (multipart: field `doc_type` first, then the PDF `file`, up to 10 MB; scanned before it is stored)",
    tags: ["Seller KYC"],
    body: DocumentUploadForm,
    response: DocumentUploadResult,
    status: 201,
    maxQueries: 10,
  })
  async upload(@Ctx() s: RequestState, @Req() req: ApiRequest): Promise<DocumentUploadResult> {
    const o = this.own(s);
    const sellerId = await this.sellerId(o);
    if (!req.isMultipart()) throw Problems.unsupportedMediaType();
    const part: MultipartFile | undefined = await req.file({ limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1, fields: 3, parts: 4 } });
    if (part === undefined) throw Problems.badRequest("file-required");
    const field = (name: string): string | undefined => {
      const f = part.fields[name];
      return f !== undefined && !Array.isArray(f) && f.type === "field" && typeof f.value === "string" ? f.value : undefined;
    };
    const form = DocumentUploadForm.safeParse({ doc_type: field("doc_type"), ...(field("expires_on") === undefined ? {} : { expires_on: field("expires_on") }) });
    if (!form.success) throw Problems.validation([{ path: "/body/doc_type", code: "invalid_value" }]);
    const bytes = await part.toBuffer();
    // Platform-owned document uploaded as the applicant (shopper principal, policy action seller.onboard on their own application;
    // media.created_by = the applicant, which addDocument re-checks).
    const actor: Principal = { kind: "shopper", userId: o.userId, marketId: o.marketId, roles: [], scopes: [] };
    const asset = await this.deps.catalog(o.marketId).media.ingest({ bytes, declaredMime: part.mimetype, kind: "document", actor });
    if (asset.status !== "ready") throw Problems.unprocessable("media-rejected", [{ path: "/body/file", code: "media_rejected" }]);
    const doc = await o.svc.onboarding.addDocument(o.userId, sellerId, { kind: form.data.doc_type, mediaAssetId: asset.id, ...(form.data.expires_on === undefined ? {} : { expiresOn: form.data.expires_on }) });
    return { document_id: doc.documentId, media_id: asset.id, doc_type: form.data.doc_type };
  }

  @Put("bank-account")
  @Authorize(OWN_ACCOUNT, self)
  @RateLimit({ budget: SELLER_ONBOARDING_BUDGET })
  @Contract({ operationId: "setOnboardingBankAccount", summary: "Set the payout IBAN (encrypted at rest; only the last four characters are ever returned)", tags: ["Seller KYC"], body: BankAccountInput, response: BankAccountResult, maxQueries: 8 })
  async bank(@Ctx() s: RequestState, @Body() b: z.infer<typeof BankAccountInput>): Promise<BankAccountResult> {
    const o = this.own(s);
    const r = await o.svc.onboarding.setBankAccount(o.userId, await this.sellerId(o), { iban: b.iban, accountName: b.account_name });
    return { iban_last4: r.last4 };
  }

  @Post("submit")
  @HttpCode(200)
  @Authorize(OWN_ACCOUNT, self)
  @RateLimit({ budget: SELLER_ONBOARDING_BUDGET })
  @Contract({ operationId: "submitSellerOnboarding", summary: "Submit for review (all documents, bank account, legal identity and a 21+ signatory; 422 lists the gaps)", tags: ["Seller KYC"], body: EmptyBody, response: SellerOnboarding, maxQueries: 20 })
  async submit(@Ctx() s: RequestState): Promise<SellerOnboarding> {
    const o = this.own(s);
    const sellerId = await this.sellerId(o);
    await o.svc.onboarding.submit(o.userId, sellerId);
    return this.get(s);
  }
}
