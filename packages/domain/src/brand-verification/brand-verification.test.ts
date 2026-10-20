import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  COUNTRIES, aggregateAutoChecks, claimPriorityKey, compareBrandNames, compareOwner, detectClaimConflicts, dnsChallengeToken,
  evaluateCountry, evaluateEmailAttempt, jaroWinkler, normaliseBrandName, orderByPriority, requiresDualApproval, trigramSimilarity,
  trademarkKeyOf, txtContainsValue, txtRecordName, txtRecordValue, validateBrandDomain, EMAIL_MAX_ATTEMPTS, type ClaimView,
} from "./index";

describe("countries and policy", () => {
  it("has unique ISO codes with Arabic and English names", () => {
    expect(new Set(COUNTRIES.map((c) => c.code)).size).toBe(COUNTRIES.length);
    expect(COUNTRIES.length).toBeGreaterThan(240);
    expect(COUNTRIES.every((c) => /^[A-Z]{2}$/.test(c.code) && c.ar.length > 0 && c.en.length > 0)).toBe(true);
  });
  it("local brands must be Egyptian, blocked countries refused, dual approval only for GLOBAL", () => {
    expect(evaluateCountry("local", "EG")).toBe("allowed");
    expect(evaluateCountry("local", "FR")).toBe("local_must_be_egypt");
    expect(evaluateCountry("global", "KP")).toBe("blocked");
    expect(evaluateCountry("global", "ZZ")).toBe("unknown_country");
    expect(requiresDualApproval({ kind: "global", country: "MM", sanctions: "clear" })).toBe(true);
    expect(requiresDualApproval({ kind: "global", country: "FR", sanctions: "warn" })).toBe(true);
    expect(requiresDualApproval({ kind: "global", country: "FR", sanctions: "clear" })).toBe(false);
    expect(requiresDualApproval({ kind: "local", country: "EG", sanctions: "fail" })).toBe(false);
  });
});

describe("name normalisation and similarity", () => {
  it("folds case, accents, punctuation, legal suffixes and Arabic letter variants", () => {
    expect(normaliseBrandName("  Café   Nîle, LLC. ")).toBe("cafe nile");
    expect(normaliseBrandName("H&M Ltd")).toBe(normaliseBrandName("h and m limited"));
    expect(normaliseBrandName("شركة أَلنيل للملابس ش.م.م")).toBe(normaliseBrandName("النيل للملابس"));
    expect(normaliseBrandName("إيجيبت ٢٠٢٤")).toContain("2024");
    expect(normaliseBrandName("LLC")).toBe("llc");
  });
  it("scores identical, reordered and unrelated names", () => {
    expect(compareBrandNames("Nile Cotton", "nile  cotton Ltd").score).toBe(100);
    expect(compareBrandNames("Nile Cotton", "Cotton Nile").reasons).toContain("token_set_equal");
    expect(compareBrandNames("Nile", "Nile Cotton").reasons).toContain("token_subset");
    expect(compareBrandNames("Zara", "Quantum Plumbing").score).toBeLessThan(50);
  });
  it("properties: similarity is symmetric, bounded and reflexive", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), fc.string({ maxLength: 20 }), (a, b) => {
        for (const f of [jaroWinkler, trigramSimilarity]) {
          const s = f(a, b);
          expect(s).toBeGreaterThanOrEqual(0);
          expect(s).toBeLessThanOrEqual(100);
          expect(f(b, a)).toBe(s);
        }
        const n = normaliseBrandName(a);
        expect(normaliseBrandName(n)).toBe(normaliseBrandName(n));
        if (n !== "") expect(compareBrandNames(a, a).score).toBe(100);
      }),
    );
  });
  it("normalisation is idempotent", () => {
    fc.assert(fc.property(fc.string({ maxLength: 30 }), (a) => { const n = normaliseBrandName(a); expect(normaliseBrandName(n)).toBe(n); }));
  });
});

describe("domain validation (SSRF)", () => {
  it.each([
    ["127.0.0.1", "ip_literal"], ["10.0.0.1", "ip_literal"], ["0x7f.1", "ip_literal"], ["2130706433", "ip_literal"], ["[::1]", "ip_literal"],
    ["localhost", "single_label"], ["intranet.local", "internal_tld"], ["svc.internal", "internal_tld"], ["http://a.com", "not_a_hostname"],
    ["a.com/x", "not_a_hostname"], ["user@a.com", "not_a_hostname"], ["com.eg", "public_suffix"], ["gmail.com", "free_mail"],
    ["shop.myshopify.com", "shared_platform"], ["instagram.com", "shared_platform"], ["bad_label.com", "not_a_hostname"], ["-a.com", "invalid_label"], ["", "empty"],
  ])("rejects %s", (raw, reason) => {
    expect(validateBrandDomain(raw)).toEqual({ ok: false, reason });
  });
  it("returns the registrable domain", () => {
    expect(validateBrandDomain("WWW.Shop.Brand.com.")).toEqual({ ok: true, host: "shop.brand.com", domain: "brand.com" });
    expect(validateBrandDomain("store.brand.com.eg")).toMatchObject({ ok: true, domain: "brand.com.eg" });
  });
});

describe("challenges", () => {
  const hmac = (k: string, m: string) => `${k}:${m}`;
  it("builds the TXT record and token", () => {
    const t = dnsChallengeToken(hmac, "s", "app", "brand.com", "n1");
    expect(t).toBe("s:app|brand.com|n1");
    expect(txtRecordName("brand.com")).toBe("_zoutlet-verify.brand.com");
    expect(txtContainsValue(['"other"', `"${txtRecordValue(t)}"`], txtRecordValue(t))).toBe(true);
    expect(txtContainsValue(["nope"], txtRecordValue(t))).toBe(false);
  });
  it("email attempts: wrong, lock at 5, expiry, success", () => {
    const base = { status: "pending" as const, expiresAtMs: 1000, attempts: 0 };
    expect(evaluateEmailAttempt(base, 10, true)).toEqual({ kind: "verified", attempts: 1 });
    expect(evaluateEmailAttempt(base, 10, false)).toEqual({ kind: "wrong_code", attempts: 1, attemptsRemaining: EMAIL_MAX_ATTEMPTS - 1 });
    expect(evaluateEmailAttempt({ ...base, attempts: 4 }, 10, false).kind).toBe("locked");
    expect(evaluateEmailAttempt({ ...base, attempts: 5 }, 10, true).kind).toBe("locked");
    expect(evaluateEmailAttempt(base, 1000, true).kind).toBe("expired");
    expect(evaluateEmailAttempt({ ...base, status: "verified" }, 10, true).kind).toBe("not_pending");
  });
});

const claim = (o: Partial<ClaimView> & { applicationId: string; applicantId: string }): ClaimView => ({
  kind: "global", country: "FR", brandNameNorm: "lumen", domain: null, trademarkKey: null, domainVerifiedAtMs: null, trademarkMatchedAtMs: null, submittedAtMs: 100, ...o,
});

describe("claims", () => {
  it("detects name/domain/trademark conflicts but never against the same applicant", () => {
    const me = claim({ applicationId: "a", applicantId: "u1", domain: "lumen.com", trademarkKey: trademarkKeyOf("wipo", "12 34") });
    const found = detectClaimConflicts(me, [
      claim({ applicationId: "b", applicantId: "u2" }),
      claim({ applicationId: "c", applicantId: "u3", country: "DE", brandNameNorm: "other", domain: "lumen.com" }),
      claim({ applicationId: "d", applicantId: "u1" }),
      claim({ applicationId: "e", applicantId: "u4", brandNameNorm: "zzz", trademarkKey: "WIPO:1234" }),
    ]);
    expect(found.map((f) => [f.otherApplicationId, ...f.reasons])).toEqual([["b", "same_name"], ["c", "same_domain"], ["e", "same_trademark"]]);
  });
  it("first verified wins; unverified ordered by submission; total order", () => {
    const ordered = orderByPriority([
      claim({ applicationId: "x", applicantId: "1", submittedAtMs: 1 }),
      claim({ applicationId: "y", applicantId: "2", domainVerifiedAtMs: 500, submittedAtMs: 900 }),
      claim({ applicationId: "z", applicantId: "3", trademarkMatchedAtMs: 400, submittedAtMs: 950 }),
    ]);
    expect(ordered.map((c) => c.applicationId)).toEqual(["z", "y", "x"]);
    expect(claimPriorityKey(ordered[0] as ClaimView)[0]).toBe(0);
  });
});

describe("owner match and report", () => {
  it("bands the owner comparison", () => {
    expect(compareOwner("Lumen Trading LLC", "LUMEN TRADING Ltd").band).toBe("match");
    expect(compareOwner("Lumen", "Acme Holdings").band).toBe("mismatch");
  });
  it("aggregates deterministically with risk reasons", () => {
    const input = {
      applicationId: "a", kind: "global" as const, country: "MM", ranAtMs: 1,
      checks: [
        { code: "sanctions" as const, result: "warn" as const, reasons: ["possible"], evidenceIds: ["s1"] },
        { code: "domain_verified" as const, result: "pass" as const, reasons: [], evidenceIds: [] },
      ],
    };
    const r = aggregateAutoChecks(input);
    expect(r.risk).toBe("high");
    expect(r.dualApprovalRequired).toBe(true);
    expect(r.checks.map((c) => c.code)).toEqual(["domain_verified", "sanctions"]);
    expect(aggregateAutoChecks({ ...input, checks: [...input.checks].reverse() })).toEqual(r);
    const low = aggregateAutoChecks({ applicationId: "a", kind: "local", country: "EG", ranAtMs: 1, checks: [{ code: "domain_verified", result: "pass", reasons: [], evidenceIds: [] }] });
    expect(low.risk).toBe("low");
    expect(low.dualApprovalRequired).toBe(false);
  });
});
