import { normalizeName } from "./domain/iban.js";
import type { KycCheckInput, KycCheckOutcome, KycCheckPort, StrongAuthMethod, StrongAuthPort } from "./application/ports.js";

/**
 * TEST ONLY. Passes unless told otherwise: IBAN holder must equal the legal name (normalised), and the commercial
 * register number "SANCTIONED" is a sanctions hit. Records every call (never the IBAN).
 */
export class FakeKycCheck implements KycCheckPort {
  readonly calls: string[] = [];
  failOcrFor: KycCheckInput["documents"][number]["kind"] | undefined;
  down = false;

  run(input: KycCheckInput): Promise<KycCheckOutcome> {
    if (this.down) return Promise.reject(new Error("provider down"));
    this.calls.push(input.caseId);
    const nameOk = normalizeName(input.accountName) === normalizeName(input.legalNameAr);
    const doc = this.failOcrFor === undefined ? undefined : input.documents.find((d) => d.kind === this.failOcrFor);
    return Promise.resolve({
      provider: "fake-kyc",
      providerRef: `fake-${input.caseId.slice(0, 8)}`,
      checks: [
        { type: "sanctions", result: input.commercialRegisterNo === "SANCTIONED" ? "fail" : "pass" },
        { type: "iban_name_match", result: nameOk ? "pass" : "fail", scoreBp: nameOk ? 10000 : 0 },
        ...(doc === undefined ? [] : [{ type: "document_ocr" as const, result: "fail" as const, documentId: doc.id }]),
      ],
    });
  }
}

/** TEST ONLY. Accepts proofs that start with "ok:". */
export class FakeStrongAuth implements StrongAuthPort {
  verifyEnrollment(input: { userId: string; method: StrongAuthMethod; proof: string }): Promise<boolean> {
    return Promise.resolve(input.proof.startsWith("ok:"));
  }
}
