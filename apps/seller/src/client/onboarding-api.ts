import { uuidv7 } from "@outlet/ids";
import { z } from "zod";
import type { ApiFailure, ApiResult } from "./seller-api";
import { DOC_TYPES, KYC_STATES, type DocType } from "../lib/onboarding-model";

/** Browser client for the applicant's KYC routes (`/api/seller/{market}/onboarding...`), shapes copied from the SERVED openapi.generated.yaml. */

export const OnboardingWire = z.object({
  seller_id: z.string(),
  kyc_case_id: z.string(),
  status: z.enum(KYC_STATES),
  submitted_at: z.string().nullable(),
  decided_at: z.string().nullable(),
  decision_reason: z.string().nullable(),
  version: z.number().int(),
  gaps: z.array(z.string()),
  required_documents: z.array(z.enum(DOC_TYPES)),
});
export type OnboardingWire = z.infer<typeof OnboardingWire>;
const Started = z.object({ seller_id: z.string(), kyc_case_id: z.string() });
const Bank = z.object({ iban_last4: z.string() });
const Doc = z.object({ document_id: z.string(), media_id: z.string(), doc_type: z.enum(DOC_TYPES) });

export interface StartBody {
  legal_type: "company" | "sole_trader";
  legal_name_ar?: string;
  legal_name_en?: string;
  commercial_register_no?: string;
  tax_card_no?: string;
  governorate_code?: string;
  governorate_name_ar?: string;
}

export interface OnboardingApi {
  get(): Promise<ApiResult<OnboardingWire>>;
  start(body: StartBody): Promise<ApiResult<{ seller_id: string; kyc_case_id: string }>>;
  setBank(iban: string, accountName: string): Promise<ApiResult<{ iban_last4: string }>>;
  uploadDocument(type: DocType, file: File, onProgress: (fraction: number) => void): Promise<ApiResult<{ document_id: string }>>;
  submit(): Promise<ApiResult<OnboardingWire>>;
}

const Problem = z.object({ code: z.string(), errors: z.array(z.object({ code: z.string() })).optional() });
const failure = async (res: { status: number; text(): Promise<string> }): Promise<ApiFailure> => {
  try {
    const p = Problem.safeParse(JSON.parse(await res.text()));
    if (p.success) return { ok: false, status: res.status, code: p.data.code, reasons: (p.data.errors ?? []).map((e) => e.code) };
  } catch {
    // not a Problem body
  }
  return { ok: false, status: res.status, code: "unknown", reasons: [] };
};
const NETWORK: ApiFailure = { ok: false, status: 0, code: "network", reasons: [] };

export const createOnboardingApi = (market: string, fetchImpl: typeof fetch = (...a) => fetch(...a), xhrFactory: () => XMLHttpRequest = () => new XMLHttpRequest()): OnboardingApi => {
  const base = `/api/seller/${market}/onboarding`;
  const call = async <T>(schema: z.ZodType<T>, path: string, method: string, body?: unknown): Promise<ApiResult<T>> => {
    const headers: Record<string, string> = { accept: "application/json" };
    if (method !== "GET") headers["idempotency-key"] = uuidv7();
    if (body !== undefined) headers["content-type"] = "application/json";
    try {
      const res = await fetchImpl(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!res.ok) return await failure(res);
      const parsed = schema.safeParse(await res.json());
      return parsed.success ? { ok: true, data: parsed.data } : { ok: false, status: res.status, code: "bad-response", reasons: [] };
    } catch {
      return NETWORK;
    }
  };
  return {
    get: () => call(OnboardingWire, "", "GET"),
    start: (body) => call(Started, "", "POST", body),
    setBank: (iban, accountName) => call(Bank, "/bank-account", "PUT", { iban, account_name: accountName }),
    submit: () => call(OnboardingWire, "/submit", "POST", {}),
    uploadDocument: (type, file, onProgress) =>
      new Promise((resolve) => {
        const xhr = xhrFactory();
        xhr.open("POST", `${base}/documents`);
        xhr.setRequestHeader("idempotency-key", uuidv7());
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(e.loaded / e.total);
        };
        xhr.onerror = () => { resolve(NETWORK); };
        xhr.onload = () => {
          if (xhr.status < 200 || xhr.status >= 300) {
            void failure({ status: xhr.status, text: () => Promise.resolve(xhr.responseText) }).then(resolve);
            return;
          }
          try {
            const parsed = Doc.safeParse(JSON.parse(xhr.responseText));
            resolve(parsed.success ? { ok: true, data: { document_id: parsed.data.document_id } } : { ok: false, status: xhr.status, code: "bad-response", reasons: [] });
          } catch {
            resolve({ ok: false, status: xhr.status, code: "bad-response", reasons: [] });
          }
        };
        const form = new FormData();
        form.append("doc_type", type); // the API reads `doc_type` before the file stream
        form.append("file", file, file.name);
        xhr.send(form);
      }),
  };
};
