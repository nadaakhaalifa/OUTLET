import { describe, expect, it } from "vitest";
import { createOnboardingApi, type TokenSource } from "../api/onboarding-client";
import type { Application, Checklist, Requirements } from "../api/schemas-onboarding";
import { buildCsp, uploadOriginsOf } from "../csp";
import { isApplicantPath, isBarePath, isPublicPath } from "../lib/paths";
import { encodeQr, qrPath } from "../lib/qr";
import {
  buildFormModel, buildPatch, documentSlots, documentState, fieldsBySection, initialValues, missingDocuments, submitBlockers, uploadPercent,
  validateAll, validateField, validateFile, validateNewApplication, type DocSlot,
} from "../view-models/application-form";
import { statusVM, timeline, validateAppeal } from "../view-models/application-status";
import {
  b64urlToBytes, bytesToB64url, canLeaveRecoveryCodes, classifyWebauthnError, groupSecret, normalizeCode, normalizePhone, parseOtpauth, resendRemaining,
  safeNextPath, serializeAssertion, strongFactorStep, switchMethod, toCreationOptions, toRequestOptions, validateSignUp,
} from "../view-models/auth-flow";
import { checkEgyptIban, formatIban, mod97, normalizeIban } from "../view-models/iban";
import { checklistVM, routeAfterSignIn } from "../view-models/onboarding-checklist";
import {
  cairoLocalToIso, hasVersionConflict, parseEgpToPiastres, payoutVM, piastresToEgpInput, prefCells, prefsChanges, teamRows, validateInvite,
  validateProfile, validateReturnPolicy, validateShipping, validateVacation, type ProfileValues,
} from "../view-models/store-settings";
import { fakeTransport, json, UUID_A, UUID_B } from "./fake-transport";

/* A valid Egyptian-format IBAN built with the same mod-97 rule (EG + check + 25 digits). */
function makeIban(body25: string): string {
  const rearranged = `${body25}141600`; // "EG00" moved to the end: E=14 G=16
  const rem = mod97(rearranged) ?? 0;
  const check = String(98 - rem).padStart(2, "0");
  return `EG${check}${body25}`;
}
const IBAN = makeIban("0019000500000000263180002");

const REQ: Requirements = {
  kind: "local", country: "EG", version: 1,
  fields: [
    { code: "brand_name", label_ar: "اسم", label_en: "Brand name", required: true, format: "text" },
    { code: "ownership_basis", label_ar: "أساس", label_en: "Ownership", required: true, format: "text" },
    { code: "commercial_register_no", label_ar: "سجل", label_en: "CR", required: true, format: "commercial_register_no" },
    { code: "tax_card_no", label_ar: "بطاقة", label_en: "Tax", required: true, format: "tax_card_no" },
    { code: "contact_phone", label_ar: "هاتف", label_en: "Phone", required: true, format: "phone" },
    { code: "signatory_dob", label_ar: "ميلاد", label_en: "DOB", required: true, format: "date", min_signatory_age: 21 },
    { code: "website_domain", label_ar: "موقع", label_en: "Website", required: false, format: "domain" },
    { code: "future_field", label_ar: "جديد", label_en: "Future", required: true, format: "text" },
  ],
  documents: [
    { code: "commercial_register", label_ar: "سجل", label_en: "CR", required: true, accepts: ["pdf", "jpg"], max_bytes: 1000 },
    { code: "trademark_certificate", label_ar: "علامة", label_en: "TM", required: true, one_of_group: "own", accepts: ["pdf"], max_bytes: 1000 },
    { code: "brand_authorization", label_ar: "تفويض", label_en: "Auth", required: true, one_of_group: "own", accepts: ["pdf"], max_bytes: 1000 },
  ],
  website_verification: "required_if_website",
};

const doc = (over: Partial<Application["documents"][number]>): Application["documents"][number] => ({
  id: UUID_A, requirement_code: "commercial_register", content_type: "application/pdf", size_bytes: 10, upload_status: "uploaded",
  scan_status: "clean", review_status: "unreviewed", created_at: "2026-10-11T10:00:00.000Z", ...over,
});

const APP: Application = {
  id: UUID_A, status: "DRAFT", brand_kind: "local", country: "EG", brand_name: "Nour", documents: [], requested_items: [],
  allowed_actions: ["edit", "submit", "upload_document", "verify_domain"], created_at: "2026-10-11T10:00:00.000Z", updated_at: "2026-10-11T10:00:00.000Z",
};

describe("iban", () => {
  it("accepts a checksum-valid Egyptian IBAN in any spacing and case", () => {
    expect(checkEgyptIban(IBAN).valid).toBe(true);
    expect(checkEgyptIban(formatIban(IBAN).toLowerCase()).valid).toBe(true);
    expect(normalizeIban(" eg12 3 ")).toBe("EG123");
  });
  it("explains each failure", () => {
    expect(checkEgyptIban("").problem).toBe("empty");
    expect(checkEgyptIban("GB82WEST12345698765432").problem).toBe("country");
    expect(checkEgyptIban("EG12").problem).toBe("length");
    expect(checkEgyptIban(`EG${"1".repeat(26)}A`).problem).toBe("characters");
    const bad = `${IBAN.slice(0, 2)}${IBAN.slice(2, 4) === "00" ? "01" : "00"}${IBAN.slice(4)}`;
    expect(checkEgyptIban(bad).problem).toBe("checksum");
  });
  it("detects a single changed digit", () => {
    const i = 10;
    const changed = IBAN.slice(0, i) + String((Number(IBAN[i]) + 1) % 10) + IBAN.slice(i + 1);
    expect(checkEgyptIban(changed).valid).toBe(false);
  });
});

describe("auth flow", () => {
  it("normalises Egyptian and international phones, Arabic digits included", () => {
    expect(normalizePhone("01012345678")).toBe("+201012345678");
    expect(normalizePhone("٠١٠١٢٣٤٥٦٧٨")).toBe("+201012345678");
    expect(normalizePhone("+20 101 234 5678")).toBe("+201012345678");
    expect(normalizePhone("00201012345678")).toBe("+201012345678");
    expect(normalizePhone("+971501234567")).toBe("+971501234567");
    expect(normalizePhone("0301234")).toBeNull();
    expect(normalizePhone("+2010123")).toBeNull();
  });
  it("validates sign-up and OTP input", () => {
    expect(validateSignUp("01012345678", "a@b.co").errors).toEqual({});
    expect(validateSignUp("x", "nope").errors).toEqual({ phone: "ob.auth.err.phone", email: "ob.auth.err.email" });
    expect(normalizeCode("١٢٣٤٥٦")).toBe("123456");
    expect(normalizeCode("12345")).toBeNull();
  });
  it("picks the strong-factor step and falls back to TOTP when passkeys are unsupported", () => {
    expect(strongFactorStep("enrol_strong_factor", true)).toMatchObject({ step: "enrol_passkey", unsupportedNotice: false });
    expect(strongFactorStep("enrol_strong_factor", false)).toMatchObject({ step: "enrol_totp", unsupportedNotice: true });
    expect(strongFactorStep("assert_strong_factor", true).step).toBe("assert_passkey");
    expect(switchMethod("assert_passkey")).toBe("assert_totp");
    expect(switchMethod(switchMethod("enrol_totp"))).toBe("enrol_totp");
  });
  it("forces acknowledgement of recovery codes and counts the resend timer down", () => {
    expect(canLeaveRecoveryCodes(false, true)).toBe(false);
    expect(canLeaveRecoveryCodes(true, true)).toBe(true);
    expect(resendRemaining(30, 12_000)).toBe(18);
    expect(resendRemaining(30, 99_000)).toBe(0);
  });
  it("only allows same-origin relative next paths", () => {
    expect(safeNextPath("/settings/payout")).toBe("/settings/payout");
    expect(safeNextPath("//evil.example")).toBe("/start");
    expect(safeNextPath("https://evil.example")).toBe("/start");
    expect(safeNextPath("/\\evil")).toBe("/start");
    expect(safeNextPath(null)).toBe("/start");
  });
  it("parses an otpauth URI for manual entry", () => {
    const p = parseOtpauth("otpauth://totp/Z-OUTLET:me%40x.co?secret=JBSWY3DPEHPK3PXP&issuer=Z-OUTLET");
    expect(p).toEqual({ secret: "JBSWY3DPEHPK3PXP", issuer: "Z-OUTLET", account: "me@x.co" });
    expect(groupSecret("JBSWY3DPEHPK3PXP")).toBe("JBSW Y3DP EHPK 3PXP");
    expect(parseOtpauth("https://x")).toBeNull();
    expect(parseOtpauth("otpauth://totp/a?secret=!!")).toBeNull();
  });
  it("round-trips base64url and builds WebAuthn options", () => {
    const bytes = new Uint8Array([251, 255, 0, 1, 2]);
    expect(Array.from(b64urlToBytes(bytesToB64url(bytes)))).toEqual(Array.from(bytes));
    const creation = toCreationOptions({
      challenge: bytesToB64url(new Uint8Array([1, 2, 3])), rp: { name: "Z", id: "seller.example" },
      user: { id: bytesToB64url(new Uint8Array([9])), name: "u", displayName: "U" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      excludeCredentials: [{ type: "public-key", id: bytesToB64url(new Uint8Array([5])) }],
    });
    expect(creation?.rp.id).toBe("seller.example");
    expect(creation?.attestation).toBe("none");
    expect(creation?.authenticatorSelection?.userVerification).toBe("required");
    expect(creation?.excludeCredentials?.length).toBe(1);
    expect(toCreationOptions({ challenge: "x" })).toBeNull();
    const req = toRequestOptions({ challenge: bytesToB64url(new Uint8Array([7])), rpId: "seller.example", allowCredentials: [] });
    expect(req?.userVerification).toBe("required");
    expect(toRequestOptions({})).toBeNull();
  });
  it("serialises an assertion without a user handle when absent", () => {
    const buf = new Uint8Array([1, 2]).buffer;
    const s = serializeAssertion({ id: "a", rawId: buf, type: "public-key", response: { clientDataJSON: buf, authenticatorData: buf, signature: buf, userHandle: null } });
    expect(JSON.stringify(s)).not.toContain("userHandle");
    expect(classifyWebauthnError("NotAllowedError")).toBe("cancelled");
    expect(classifyWebauthnError("NotSupportedError")).toBe("unsupported");
    expect(classifyWebauthnError(null)).toBe("failed");
  });
});

describe("requirements to form", () => {
  const model = buildFormModel(REQ, "en");
  it("maps known codes to API paths and reports unknown ones", () => {
    expect(model.fields.map((f) => f.code)).toContain("commercial_register_no");
    expect(model.unmapped).toEqual(["future_field"]);
    const own = model.fields.find((f) => f.code === "ownership_basis");
    expect(own?.input).toBe("select");
    expect(own?.options.length).toBe(3);
    expect(fieldsBySection(model).map((s) => s.section)).toEqual(["brand", "registration", "contact", "signatory"]);
  });
  it("uses the Arabic label for the Arabic locale", () => {
    expect(buildFormModel(REQ, "ar").fields[0]?.label).toBe("اسم");
  });
  it("validates formats, required and signatory age", () => {
    const now = Date.parse("2026-10-11T00:00:00Z");
    const cr = model.fields.find((f) => f.code === "commercial_register_no");
    const dob = model.fields.find((f) => f.code === "signatory_dob");
    if (cr === undefined || dob === undefined) throw new Error("fixture");
    expect(validateField(cr, "", "EG", now, false)).toBe("ob.form.err.required");
    expect(validateField(cr, "abc", "EG", now, false)).toBe("ob.form.err.format");
    expect(validateField(cr, "123456", "EG", now, false)).toBeNull();
    expect(validateField(dob, "2010-01-01", "EG", now, false)).toBe("ob.form.err.under_age");
    expect(validateField(dob, "1990-02-30", "EG", now, false)).toBe("ob.form.err.date");
    expect(validateField(dob, "1990-05-05", "EG", now, false)).toBeNull();
    expect(validateField(dob, "", "EG", now, true)).toBeNull();
  });
  it("builds a nested PATCH from non-empty values only", () => {
    const patch = buildPatch(model, { brand_name: " Nour ", commercial_register_no: "٢٣٤٥٦٧", contact_phone: "01012345678", tax_card_no: "", ownership_basis: "brand_owner" });
    expect(patch).toEqual({
      brand_name: "Nour", ownership_basis: "brand_owner", registration: { commercial_register_no: "234567" }, contact: { phone_e164: "+201012345678" },
    });
  });
  it("prefills stored values but never write-only identity fields", () => {
    const v = initialValues({ ...APP, legal_name: "Nour Co", registration: { tax_card_no: "123-456-789" } }, model);
    expect(v.tax_card_no).toBe("123-456-789");
    expect(v.signatory_dob).toBeUndefined();
  });
  it("validates the new-application step", () => {
    expect(validateNewApplication("local", "EG", "Nour")).toEqual({});
    expect(validateNewApplication("local", "AE", "Nour").country).toBe("ob.form.err.local_egypt");
    expect(validateNewApplication(null, "EG", "N").kind).toBeDefined();
    expect(validateNewApplication("global", "ARE", "Nour").country).toBe("ob.form.err.country");
  });
});

describe("documents", () => {
  it("derives slot state from upload, scan and review status", () => {
    expect(documentState(null)).toBe("missing");
    expect(documentState(doc({ upload_status: "awaiting_upload" }))).toBe("awaiting");
    expect(documentState(doc({ scan_status: "pending" }))).toBe("scanning");
    expect(documentState(doc({ scan_status: "infected" }))).toBe("infected");
    expect(documentState(doc({ review_status: "rejected" }))).toBe("rejected");
    expect(documentState(doc({}))).toBe("ready");
  });
  it("treats a one-of group as satisfied by any ready member", () => {
    const empty = documentSlots(REQ, APP, "en");
    expect(missingDocuments(empty)).toEqual(["commercial_register", "own"]);
    const filled = documentSlots(REQ, { ...APP, documents: [doc({}), doc({ id: UUID_B, requirement_code: "brand_authorization" })] }, "en");
    expect(missingDocuments(filled)).toEqual([]);
  });
  it("checks file size and declared type, and clamps progress", () => {
    const slot: Pick<DocSlot, "accepts" | "maxBytes"> = { accepts: ["application/pdf"], maxBytes: 1000 };
    expect(validateFile({ size: 0, type: "application/pdf" }, slot)).toBe("empty");
    expect(validateFile({ size: 2000, type: "application/pdf" }, slot)).toBe("too_large");
    expect(validateFile({ size: 10, type: "application/x-msdownload" }, slot)).toBe("type");
    expect(validateFile({ size: 10, type: "application/pdf" }, slot)).toBeNull();
    expect(uploadPercent(50, 200)).toBe(25);
    expect(uploadPercent(500, 200)).toBe(100);
    expect(uploadPercent(1, 0)).toBe(0);
  });
});

describe("submit readiness", () => {
  const model = buildFormModel(REQ, "en");
  const okValues = { brand_name: "Nour", ownership_basis: "brand_owner", commercial_register_no: "123456", tax_card_no: "123456789", contact_phone: "+201012345678", signatory_dob: "1990-05-05" };
  const acks = { agreement: true, dpa: true, monitoring: true };
  it("lists blockers per step and clears them when complete", () => {
    const blocked = submitBlockers({ req: REQ, app: APP, model, values: {}, nowMs: Date.now(), acks: { agreement: false, dpa: true, monitoring: true } });
    expect(new Set(blocked.map((b) => b.step))).toEqual(new Set(["details", "documents", "review"]));
    const app: Application = { ...APP, documents: [doc({}), doc({ id: UUID_B, requirement_code: "trademark_certificate" })] };
    expect(submitBlockers({ req: REQ, app, model, values: okValues, nowMs: Date.parse("2026-10-11T00:00:00Z"), acks })).toEqual([]);
  });
  it("requires domain verification when a website is given (required_if_website)", () => {
    const app: Application = { ...APP, documents: [doc({}), doc({ id: UUID_B, requirement_code: "trademark_certificate" })] };
    const b = submitBlockers({ req: REQ, app, model, values: { ...okValues, website_domain: "nour.example.com" }, nowMs: Date.parse("2026-10-11T00:00:00Z"), acks });
    expect(b.map((x) => x.step)).toEqual(["domain"]);
    const verified: Application = { ...app, domain_verification: { method: "dns_txt", domain: "nour.example.com", status: "verified" } };
    expect(submitBlockers({ req: REQ, app: verified, model, values: { ...okValues, website_domain: "nour.example.com" }, nowMs: Date.parse("2026-10-11T00:00:00Z"), acks })).toEqual([]);
  });
  it("validateAll aggregates by code", () => {
    expect(Object.keys(validateAll(model, {}, "EG", Date.now(), new Set()))).toContain("brand_name");
  });
});

describe("status timeline", () => {
  it("marks progress, problems and the final state", () => {
    expect(timeline("DRAFT").every((s) => s.state === "upcoming")).toBe(true);
    expect(timeline("AUTO_CHECKS").map((s) => s.state)).toEqual(["done", "current", "upcoming", "upcoming"]);
    expect(timeline("NEEDS_INFO").map((s) => s.state)).toEqual(["done", "done", "problem", "upcoming"]);
    expect(timeline("APPROVED").map((s) => s.state)).toEqual(["done", "done", "done", "done"]);
    expect(timeline("REJECTED")[3]?.state).toBe("problem");
  });
  it("offers fix-and-resubmit only when every requested item is satisfied", () => {
    const base: Application = {
      ...APP, status: "NEEDS_INFO", allowed_actions: ["edit", "resubmit", "withdraw"],
      requested_items: [{ code: "doc", kind: "document", message_ar: "ارفع", message_en: "Upload", satisfied: false }],
    };
    const vm = statusVM(base, "en");
    expect(vm.canFix).toBe(true);
    expect(vm.canResubmit).toBe(false);
    expect(vm.requested[0]?.message).toBe("Upload");
    expect(statusVM({ ...base, requested_items: [{ ...(base.requested_items[0] ?? { code: "d", kind: "document", message_ar: "", message_en: "" }), satisfied: true }] }, "ar").canResubmit).toBe(true);
  });
  it("shows the rejection reason, reapply date and appeal rules", () => {
    const rejected: Application = {
      ...APP, status: "REJECTED", allowed_actions: ["appeal"],
      decision: { decision: "rejected", reason_code: "documents_unreadable", message_ar: "م", message_en: "m", decided_at: "2026-10-11T10:00:00Z", reapply_after: "2026-11-10T10:00:00Z", appeal_allowed: true },
    };
    const vm = statusVM(rejected, "en");
    expect(vm.decision?.reasonKey).toBe("ob.reason.documents_unreadable");
    expect(vm.canAppeal).toBe(true);
    expect(statusVM({ ...rejected, appeal_used: true }, "en").canAppeal).toBe(false);
    expect(validateAppeal("short")).toBe("ob.appeal.err.short");
    expect(validateAppeal("x".repeat(30))).toBeNull();
  });
});

describe("onboarding checklist", () => {
  const list: Checklist = {
    store_id: UUID_A,
    items: [
      { code: "invite_team", done: false, required_for_publish: false },
      { code: "add_first_product", done: false, required_for_publish: true },
      { code: "complete_store_profile", done: true, required_for_publish: true },
      { code: "add_payout_iban", done: false, required_for_publish: true },
    ],
  };
  it("orders rows, counts progress and picks the next actionable required step", () => {
    const vm = checklistVM(list, "owner");
    expect(vm.rows.map((r) => r.code)).toEqual(["complete_store_profile", "add_payout_iban", "add_first_product", "invite_team"]);
    expect(vm.doneCount).toBe(1);
    expect(vm.percent).toBe(25);
    expect(vm.requiredRemaining).toBe(2);
    expect(vm.readyToPublish).toBe(false);
    expect(vm.next?.code).toBe("add_payout_iban");
  });
  it("skips steps the role cannot perform", () => {
    expect(checklistVM(list, "catalog").next?.code).toBe("add_first_product");
    expect(checklistVM(list, "support").rows.find((r) => r.code === "add_payout_iban")?.actionable).toBe(false);
  });
  it("is ready when required items are done", () => {
    const done: Checklist = { ...list, items: list.items.map((i) => ({ ...i, done: i.required_for_publish })) };
    const vm = checklistVM(done, "owner");
    expect(vm.readyToPublish).toBe(true);
    expect(vm.next?.code).toBe("invite_team");
  });
  it("routes after sign-in", () => {
    const m = [{ store_id: UUID_A, role: "owner" as const }];
    expect(routeAfterSignIn({ memberships: [], applicationStatuses: [], applicationIds: [], checklist: null })).toBe("/apply");
    expect(routeAfterSignIn({ memberships: [], applicationStatuses: ["REJECTED", "DRAFT"], applicationIds: [UUID_B, UUID_A], checklist: null })).toBe(`/apply/${UUID_A}`);
    expect(routeAfterSignIn({ memberships: m, applicationStatuses: [], applicationIds: [], checklist: list })).toBe("/onboarding");
    expect(routeAfterSignIn({ memberships: m, applicationStatuses: [], applicationIds: [], checklist: { ...list, items: [] } })).toBe("/dashboard");
  });
});

describe("store settings rules", () => {
  it("parses EGP to integer piastres without floats", () => {
    expect(parseEgpToPiastres("2000")).toBe("200000");
    expect(parseEgpToPiastres("2,000.5")).toBe("200050");
    expect(parseEgpToPiastres("١٥٠٠٫٢٥")).toBe("150025");
    expect(parseEgpToPiastres("1.234")).toBeNull();
    expect(parseEgpToPiastres("abc")).toBeNull();
    expect(piastresToEgpInput("200050")).toBe("2000.50");
    expect(piastresToEgpInput("200000")).toBe("2000");
  });
  it("enforces statutory return-policy minimums (14 and 30 days) and the 90 day cap", () => {
    const ok = { changeOfMindDays: "14", defectDays: "30", policyAr: "", policyEn: "" };
    expect(validateReturnPolicy(ok)).toEqual({});
    expect(validateReturnPolicy({ ...ok, changeOfMindDays: "13" }).changeOfMindDays).toBe("ob.set.err.policy_min");
    expect(validateReturnPolicy({ ...ok, defectDays: "29" }).defectDays).toBe("ob.set.err.policy_min");
    expect(validateReturnPolicy({ ...ok, defectDays: "91" }).defectDays).toBe("ob.set.err.policy_max");
    expect(validateReturnPolicy({ ...ok, policyEn: "text" }).policyAr).toBe("ob.set.err.ar_first");
  });
  it("validates the profile name as Arabic and the threshold as money", () => {
    const base: ProfileValues = {
      nameAr: "متجر النور", nameEn: "", descriptionAr: "", descriptionEn: "", changeOfMindDays: "14", defectDays: "30", policyAr: "", policyEn: "", threshold: "2000",
    };
    expect(validateProfile(base)).toEqual({});
    expect(validateProfile({ ...base, nameAr: "Nour" }).nameAr).toBe("ob.set.err.name_arabic");
    expect(validateProfile({ ...base, threshold: "x" }).threshold).toBe("ob.set.err.amount");
  });
  it("detects an optimistic-lock conflict", () => {
    expect(hasVersionConflict(3, 3)).toBe(false);
    expect(hasVersionConflict(3, 4)).toBe(true);
  });
  it("validates vacation end date within 90 days and converts Cairo local time", () => {
    const now = Date.parse("2026-10-11T10:00:00Z");
    expect(validateVacation({ enabled: false, until: "", etaExtraDays: "0" }, now)).toEqual({});
    expect(validateVacation({ enabled: true, until: "", etaExtraDays: "0" }, now).until).toBe("ob.set.err.vacation_until");
    expect(validateVacation({ enabled: true, until: "2026-10-10T00:00:00Z", etaExtraDays: "0" }, now).until).toBe("ob.set.err.vacation_past");
    expect(validateVacation({ enabled: true, until: "2027-03-01T00:00:00Z", etaExtraDays: "0" }, now).until).toBe("ob.set.err.vacation_max");
    expect(validateVacation({ enabled: true, until: "2026-10-20T00:00:00Z", etaExtraDays: "61" }, now).etaExtraDays).toBe("ob.set.err.eta_extra");
    expect(cairoLocalToIso("2026-12-01T12:00")).toBe("2026-12-01T10:00:00.000Z");
    expect(cairoLocalToIso("garbage")).toBeNull();
  });
  it("validates the shipping origin", () => {
    const v = {
      governorate: "EG-C", city: "nasr-city", street: "Abbas El Akkad", building: "", landmark: "Next to the mall", contactName: "Omar", contactPhone: "01012345678",
      lat: "", lng: "", handlingHours: "48", packaging: ["standard_box"],
    };
    expect(validateShipping(v, false)).toEqual({});
    expect(validateShipping({ ...v, handlingHours: "6" }, false).handlingHours).toBe("ob.set.err.handling");
    expect(validateShipping({ ...v, lat: "10", lng: "10" }, false).pin).toBe("ob.set.err.pin");
    expect(validateShipping({ ...v, contactPhone: "" }, true)).toEqual({});
    expect(validateShipping({ ...v, contactPhone: "" }, false).contactPhone).toBe("ob.auth.err.phone");
    expect(validateShipping({ ...v, governorate: "XX" }, false).governorate).toBe("ob.set.err.governorate");
  });
  it("shows masked payout, name-match result and the 48h hold", () => {
    const now = Date.parse("2026-10-11T10:00:00Z");
    expect(payoutVM({ configured: false }, now).configured).toBe(false);
    const vm = payoutVM({
      configured: true, iban_masked: "EG** **** 1234", iban_last4: "1234", name_match_score: 92, payouts_held: true,
      held_until: "2026-10-13T10:00:00Z", activates_at: "2026-10-13T10:00:00Z", created_at: "2026-10-11T10:00:00Z",
    }, now);
    expect(vm).toMatchObject({ nameMatch: "match", held: true, holdHoursLeft: 48 });
    expect(payoutVM({ configured: true, iban_masked: "m", iban_last4: "1", name_match_score: 70, payouts_held: false, held_until: null, activates_at: null, created_at: null }, now).nameMatch).toBe("mismatch");
  });
  it("protects the last owner and limits team actions to owners", () => {
    const team = {
      members: [
        { user_id: UUID_A, role: "owner" as const, phone_masked: "+20••1", joined_at: null },
        { user_id: UUID_B, role: "catalog" as const, phone_masked: "+20••2", joined_at: null },
      ],
      invites: [],
    };
    const rows = teamRows(team, UUID_A, "owner");
    expect(rows[0]).toMatchObject({ canRemove: false, canChangeRole: false, protectedReason: "last_owner", isSelf: true });
    expect(rows[1]).toMatchObject({ canRemove: true, canChangeRole: true });
    expect(teamRows(team, UUID_B, "catalog").every((r) => !r.canRemove)).toBe(true);
    const two = { ...team, members: [...team.members.slice(0, 1), { user_id: UUID_B, role: "owner" as const, phone_masked: null, joined_at: null }] };
    expect(teamRows(two, UUID_A, "owner").every((r) => r.canRemove)).toBe(true);
    expect(validateInvite("01012345678", "manager")).toEqual({});
    expect(validateInvite("x", "owner")).toMatchObject({ phone: "ob.auth.err.phone", role: "ob.form.err.required" });
  });
  it("locks transactional in-app cells and only sends changed unlocked ones", () => {
    const wire = {
      preferences: { new_order: { in_app: true, push: true, email: false }, marketing_tips: { in_app: true, push: false } },
      transactional_events: ["new_order", "account_security"],
    };
    const cells = prefCells(wire);
    expect(cells.find((c) => c.event === "new_order" && c.channel === "in_app")?.locked).toBe(true);
    expect(cells.find((c) => c.event === "account_security" && c.channel === "email")?.locked).toBe(true);
    expect(cells.find((c) => c.event === "marketing_tips" && c.channel === "in_app")?.locked).toBe(false);
    const wanted = new Set(["new_order:in_app", "new_order:push", "new_order:email", "marketing_tips:in_app"]);
    expect(prefsChanges(cells, wanted)).toEqual({ new_order: { email: true } });
  });
});

describe("onboarding api client", () => {
  const tokens = (bearer: string | null, refreshed = false): TokenSource & { refreshCalls: number } => {
    let cur = bearer;
    const t = {
      refreshCalls: 0,
      async bearer() { return cur; },
      async refresh() { t.refreshCalls += 1; if (refreshed) cur = "new"; return refreshed; },
    };
    return t;
  };
  const challenge = { challenge_id: UUID_A, expires_in: 300, resend_after: 30 };

  it("sends the OTP request without any bearer token and with an idempotency key", async () => {
    const tr = fakeTransport({ "POST /v1/seller/auth/otp/request": () => json(challenge) });
    const api = createOnboardingApi({ transport: tr, tokens: tokens(null), newIdempotencyKey: () => "k-1" });
    const r = await api.requestOtp({ phone_e164: "+201012345678", email: "a@b.co", locale: "ar" });
    expect(r.ok).toBe(true);
    expect(tr.calls[0]?.headers?.authorization).toBeUndefined();
    expect(tr.calls[0]?.headers?.["idempotency-key"]).toBe("k-1");
  });
  it("fails closed with unauthorized when a bearer call has no token", async () => {
    const tr = fakeTransport({});
    const api = createOnboardingApi({ transport: tr, tokens: tokens(null), newIdempotencyKey: () => "k" });
    const r = await api.checklist();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("unauthorized");
    expect(tr.calls).toHaveLength(0);
  });
  it("refreshes once on 401 and replays with the same idempotency key", async () => {
    let n = 0;
    const tr = fakeTransport({
      "POST /v1/seller/applications": (req) => {
        n += 1;
        if (n === 1) return json({ title: "no" }, 401);
        expect(req.headers?.authorization).toBe("Bearer new");
        return json({ ...APP });
      },
    });
    const t = tokens("old", true);
    const api = createOnboardingApi({ transport: tr, tokens: t, newIdempotencyKey: () => "k-fixed" });
    const r = await api.createApplication({ brand_kind: "local", country: "EG", brand_name: "Nour" });
    expect(r.ok).toBe(true);
    expect(t.refreshCalls).toBe(1);
    expect(tr.calls[0]?.headers?.["idempotency-key"]).toBe(tr.calls[1]?.headers?.["idempotency-key"]);
  });
  it("uses a caller-supplied idempotency key and maps problem codes", async () => {
    const tr = fakeTransport({
      "PUT /v1/seller/stores/0f4c1c1e-2a55-4f7e-9d2b-1a2b3c4d5e6f/payout-account": () => json({ code: "strong_factor_required", request_id: "r1" }, 422),
    });
    const api = createOnboardingApi({ transport: tr, tokens: tokens("t"), newIdempotencyKey: () => "generated" });
    const r = await api.putPayoutAccount(UUID_A, { iban: IBAN, account_holder_name: "Nour" }, { idempotencyKey: "from-form" });
    expect(tr.calls[0]?.headers?.["idempotency-key"]).toBe("from-form");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ kind: "validation", code: "strong_factor_required", requestId: "r1" });
  });
  it("rejects a response that breaks the contract and reports offline", async () => {
    const tr = fakeTransport({ "GET /v1/seller/me": () => json({ nope: true }), "GET /v1/seller/onboarding-checklist": () => "network" });
    const api = createOnboardingApi({ transport: tr, tokens: tokens("t"), newIdempotencyKey: () => "k" });
    const me = await api.me();
    expect(!me.ok && me.error.kind).toBe("contract");
    const c = await api.checklist();
    expect(!c.ok && c.error.kind).toBe("offline");
  });
  it("passes If-Match and exposes the ETag", async () => {
    const tr = fakeTransport({
      [`PATCH /v1/seller/applications/${UUID_A}`]: (req) => json({ ...APP }, 200, { etag: `"${req.headers?.["if-match"] ?? ""}-next"` }),
    });
    const api = createOnboardingApi({ transport: tr, tokens: tokens("t"), newIdempotencyKey: () => "k" });
    const r = await api.updateApplication(UUID_A, { brand_name: "x" }, { ifMatch: '"v1"' });
    expect(r.ok && r.value.etag).toBe('""v1"-next"');
  });
});

describe("qr, paths and csp", () => {
  it("encodes an otpauth URI into a square matrix with finder patterns", () => {
    const m = encodeQr("otpauth://totp/Z:a@b.c?secret=JBSWY3DPEHPK3PXP&issuer=Z");
    expect(m).not.toBeNull();
    if (m === null) return;
    expect(m.length).toBe(m[0]?.length);
    expect((m.length - 17) % 4).toBe(0);
    for (const [x, y] of [[0, 0], [m.length - 7, 0], [0, m.length - 7]] as const) {
      expect(m[y]?.[x]).toBe(true);
      expect(m[y + 3]?.[x + 3]).toBe(true);
      expect(m[y + 1]?.[x + 1]).toBe(false);
    }
    expect(qrPath(m).viewBox).toBe(m.length + 8);
    expect(encodeQr("x".repeat(400))).toBeNull();
  });
  it("classifies routes", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/apply")).toBe(false);
    expect(isApplicantPath("/apply/abc")).toBe(true);
    expect(isApplicantPath("/applyx")).toBe(false);
    expect(isBarePath("/settings/payout")).toBe(false);
    expect(isBarePath("/start")).toBe(true);
  });
  it("adds only https upload origins to connect-src", () => {
    expect(uploadOriginsOf("https://s3.example.com/path, http://bad.example, nonsense, https://s3.example.com")).toEqual(["https://s3.example.com"]);
    const csp = buildCsp({ nonce: "n", isDev: false, apiOrigin: "https://api.example.test", uploadOrigins: ["https://s3.example.com"] });
    expect(csp).toContain("connect-src 'self' https://api.example.test https://s3.example.com");
    expect(csp).not.toContain("unsafe-inline");
  });
});
