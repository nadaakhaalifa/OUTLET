import type { z } from "zod";
import type { KycCaseView, ReconItem } from "../src/lib/schemas";

export const CASE_ID = "c0de0000-0000-4000-8000-000000000001";
export const DOC_ID = "d0c00000-0000-4000-8000-000000000001";

export const kycCase: KycCaseView = {
  case: {
    id: CASE_ID, seller_id: "5e11e000-0000-4000-8000-000000000001", kind: "seller", status: "SUBMITTED", version: 1,
    documents: [{ id: DOC_ID, doc_type: "commercial_register", media_id: "3ed1a000-0000-4000-8000-000000000001", verified: false, created_at: "2026-11-01T10:00:00Z" }],
    required_documents: ["commercial_register", "tax_card"],
    signatory: { full_name_masked: "م*** ع***", national_id_last4: "4821" },
  },
  seller_legal: { legal_name_ar: "متجر النيل", commercial_register_no: "CR-884201", tax_card_no: "TC-552019", governorate_name_ar: "القاهرة" },
  checks: [{ check_type: "register_lookup", result: "pass", checked_at: "2026-11-01T10:05:00Z" }],
};

export const reconItem = (over: Partial<z.infer<typeof ReconItem>>): z.infer<typeof ReconItem> => ({
  id: "a1000000-0000-4000-8000-000000000001", run_id: "7e100000-0000-4000-8000-000000000001", source_ref_type: "psp_settlement_line", expected: { amount_minor: "250000", currency: "EGP" }, actual: null,
  status: "UNMATCHED", first_seen_at: "2026-11-01T10:00:00Z", age_days: 1, ...over,
});
