import { describe, expect, it } from "vitest";
import {
  DEFAULT_FREE_DELIVERY_ADMIN_MAX,
  INVITE_TTL_MS,
  NAME_MATCH_MIN_SCORE,
  PAYOUT_ACCOUNT_COOLING_MS,
  SellerSettingsError,
  acceptsNewOrders,
  activationTimeFor,
  applyPrefUpdate,
  assertCanChangeMember,
  courierOrderFor,
  defaultPrefs,
  etaExtraDaysFor,
  etaTransition,
  inviteTransition,
  keyBelongsToStore,
  maskPhone,
  normalizeSocialUrl,
  objectKeyFor,
  payoutHold,
  scoreNameMatch,
  sniffImage,
  validateCourierPreferences,
  validateDisplayNameAr,
  validateFreeDeliveryThreshold,
  validateHandlingHours,
  validateImageFacts,
  validateOrigin,
  validateReturnPolicy,
  validateSocialLinks,
  validateUploadRequest,
  validateVacation,
} from "./index";

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof SellerSettingsError) return e.code;
    throw e;
  }
  return "no_error";
};

const png = (w: number, h: number): Uint8Array => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};
const jpeg = (w: number, h: number): Uint8Array => {
  const b = new Uint8Array(30);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8]);
  b[13] = h >> 8;
  b[14] = h & 255;
  b[15] = w >> 8;
  b[16] = w & 255;
  return b;
};
const webpX = (w: number, h: number): Uint8Array => {
  const b = new Uint8Array(40);
  b.set([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8X"), 10, 0, 0, 0, 0, 0, 0, 0]);
  const w1 = w - 1;
  const h1 = h - 1;
  b.set([w1 & 255, (w1 >> 8) & 255, (w1 >> 16) & 255, h1 & 255, (h1 >> 8) & 255, (h1 >> 16) & 255], 24);
  return b;
};

describe("profile rules", () => {
  it("requires an Arabic display name", () => {
    expect(validateDisplayNameAr("  متجر   الأناقة ")).toBe("متجر الأناقة");
    expect(code(() => validateDisplayNameAr("Elegance"))).toBe("name_ar_must_be_arabic");
    expect(code(() => validateDisplayNameAr("ا"))).toBe("name_ar_length");
  });

  it("never allows less than the statutory return windows", () => {
    expect(validateReturnPolicy({ changeOfMindDays: 14, defectDays: 30 }).changeOfMindDays).toBe(14);
    expect(code(() => validateReturnPolicy({ changeOfMindDays: 13, defectDays: 30 }))).toBe("return_window_below_statutory_minimum");
    expect(code(() => validateReturnPolicy({ changeOfMindDays: 14, defectDays: 29 }))).toBe("defect_window_below_statutory_minimum");
    expect(code(() => validateReturnPolicy({ changeOfMindDays: 14, defectDays: 120 }))).toBe("return_window_invalid");
    expect(code(() => validateReturnPolicy({ changeOfMindDays: 14.5, defectDays: 30 }))).toBe("return_window_invalid");
    expect(validateReturnPolicy({ changeOfMindDays: 30, defectDays: 60, textAr: "سياسة", textEn: "Policy" }).defectDays).toBe(60);
    expect(code(() => validateReturnPolicy({ changeOfMindDays: 14, defectDays: 30, textEn: "Only English" }))).toBe("return_policy_arabic_required");
    expect(code(() => validateReturnPolicy({ changeOfMindDays: 14, defectDays: 30, textAr: "English as arabic" }))).toBe("return_policy_arabic_required");
  });

  it("bounds the free-delivery threshold by the admin maximum", () => {
    expect(validateFreeDeliveryThreshold(0n, DEFAULT_FREE_DELIVERY_ADMIN_MAX)).toBe(0n);
    expect(validateFreeDeliveryThreshold(DEFAULT_FREE_DELIVERY_ADMIN_MAX, DEFAULT_FREE_DELIVERY_ADMIN_MAX)).toBe(DEFAULT_FREE_DELIVERY_ADMIN_MAX);
    expect(code(() => validateFreeDeliveryThreshold(DEFAULT_FREE_DELIVERY_ADMIN_MAX + 1n, DEFAULT_FREE_DELIVERY_ADMIN_MAX))).toBe("threshold_above_admin_max");
    expect(code(() => validateFreeDeliveryThreshold(-1n, 10n))).toBe("threshold_negative");
  });

  it("accepts https social links on the right host only", () => {
    expect(normalizeSocialUrl("instagram", "https://www.instagram.com/brand")).toBe("https://www.instagram.com/brand");
    expect(code(() => normalizeSocialUrl("instagram", "http://instagram.com/x"))).toBe("social_link_invalid");
    expect(code(() => normalizeSocialUrl("instagram", "https://evil.com/instagram.com"))).toBe("social_link_wrong_host");
    expect(code(() => normalizeSocialUrl("instagram", "https://notinstagram.com/x"))).toBe("social_link_wrong_host");
    expect(code(() => normalizeSocialUrl("website", "https://127.0.0.1/x"))).toBe("social_link_invalid");
    expect(code(() => normalizeSocialUrl("website", "https://user:pw@shop.example.com"))).toBe("social_link_invalid");
    expect(code(() => normalizeSocialUrl("website", "https://localhost/x"))).toBe("social_link_invalid");
    expect(validateSocialLinks({ website: "https://shop.example.com", tiktok: "" })).toEqual({ website: "https://shop.example.com/" });
    expect(code(() => validateSocialLinks({ myspace: "https://myspace.com/x" }))).toBe("social_platform_unknown");
  });

  it("vacation pauses orders until a bounded end and adjusts the ETA", () => {
    const now = 1_000_000;
    const v = validateVacation({ enabled: true, untilMs: now + 86_400_000, etaExtraDays: 5 }, now);
    expect(acceptsNewOrders(v, now)).toBe(false);
    expect(etaExtraDaysFor(v, now)).toBe(5);
    expect(acceptsNewOrders(v, now + 86_400_000)).toBe(true);
    expect(etaExtraDaysFor(v, now + 86_400_000)).toBe(0);
    expect(code(() => validateVacation({ enabled: true, untilMs: null, etaExtraDays: 0 }, now))).toBe("vacation_until_required");
    expect(code(() => validateVacation({ enabled: true, untilMs: now + 91 * 86_400_000, etaExtraDays: 0 }, now))).toBe("vacation_too_long");
    expect(code(() => validateVacation({ enabled: true, untilMs: now + 1000, etaExtraDays: 61 }, now))).toBe("vacation_eta_invalid");
    expect(validateVacation({ enabled: false, untilMs: 5, etaExtraDays: 9 }, now)).toEqual({ enabled: false, untilMs: null, etaExtraDays: 0 });
  });
});

describe("image sniffing and limits", () => {
  it("reads png, jpeg and webp dimensions from magic bytes", () => {
    expect(sniffImage(png(800, 600))).toEqual({ type: "image/png", width: 800, height: 600 });
    expect(sniffImage(jpeg(1200, 400))).toEqual({ type: "image/jpeg", width: 1200, height: 400 });
    expect(sniffImage(webpX(1500, 500))).toEqual({ type: "image/webp", width: 1500, height: 500 });
  });
  it("rejects executables, svg and truncated data", () => {
    expect(sniffImage(new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).toBeNull();
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
    expect(sniffImage(new Uint8Array(0))).toBeNull();
  });
  it("validates declared type, size and dimensions per slot", () => {
    expect(code(() => validateUploadRequest("logo", "image/gif", 100))).toBe("image_type_not_allowed");
    expect(code(() => validateUploadRequest("logo", "image/png", 2_000_001))).toBe("image_too_large");
    expect(code(() => validateUploadRequest("logo", "image/png", 0))).toBe("image_size_invalid");
    expect(validateUploadRequest("cover", "image/webp", 4_000_000)).toBe("image/webp");
    const facts = sniffImage(png(512, 512));
    expect(validateImageFacts("logo", "image/png", 1000, facts).width).toBe(512);
    expect(code(() => validateImageFacts("logo", "image/jpeg", 1000, facts))).toBe("image_type_mismatch");
    expect(code(() => validateImageFacts("logo", "image/png", 1000, sniffImage(png(100, 100))))).toBe("image_dimensions_too_small");
    expect(code(() => validateImageFacts("logo", "image/png", 1000, sniffImage(png(5000, 5000))))).toBe("image_dimensions_too_large");
    expect(code(() => validateImageFacts("logo", "image/png", 1000, null))).toBe("image_content_not_allowed");
    expect(code(() => validateImageFacts("logo", "image/png", 3_000_000, facts))).toBe("image_too_large");
  });
  it("binds keys to the store prefix", () => {
    const key = objectKeyFor("s1", "logo", "u1", "image/png");
    expect(key).toBe("stores/s1/logo/u1.png");
    expect(keyBelongsToStore(key, "s1")).toBe(true);
    expect(keyBelongsToStore(key, "s2")).toBe(false);
    expect(keyBelongsToStore("stores/s1/../s2/x.png", "s1")).toBe(false);
  });
});

describe("name match", () => {
  it("matches identical names regardless of order, company suffixes and Arabic letter variants", () => {
    expect(scoreNameMatch("شركة النور للملابس ذ.م.م", "النور للملابس").decision).toBe("match");
    expect(scoreNameMatch("Clothes Al Nour LLC", "Al Nour Clothes").score).toBe(100);
    expect(scoreNameMatch("أحمد", "احمد").score).toBe(100);
  });
  it("tolerates a typo in a long token but explains it", () => {
    const r = scoreNameMatch("Elegence Fashion", "Elegance Fashion");
    expect(r.decision).toBe("match");
    expect(r.evidence.some((e) => e.kind === "fuzzy")).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(NAME_MATCH_MIN_SCORE);
  });
  it("rejects different parties and short-token fuzzing", () => {
    expect(scoreNameMatch("Mohamed Ali Trading", "Elegance Fashion").decision).toBe("mismatch");
    expect(scoreNameMatch("Ali Trading", "Ali Trading Egypt Group Holding").decision).toBe("mismatch");
    const r = scoreNameMatch("Nour Ali", "Nour Ala");
    expect(r.evidence.some((e) => e.kind === "missing_from_holder")).toBe(true);
    expect(scoreNameMatch("", "x").score).toBe(0);
    expect(scoreNameMatch("x", "").decision).toBe("mismatch");
  });
});

describe("bank rules", () => {
  it("holds a replacement for 48h, not the first account", () => {
    expect(activationTimeFor(1000, false)).toBe(1000);
    expect(activationTimeFor(1000, true)).toBe(1000 + PAYOUT_ACCOUNT_COOLING_MS);
    expect(payoutHold(5000, 4999)).toEqual({ held: true, untilMs: 5000 });
    expect(payoutHold(5000, 5000)).toEqual({ held: false, untilMs: null });
  });
});

describe("team rules", () => {
  it("invite states are single use", () => {
    expect(inviteTransition("PENDING", "accept")).toBe("ACCEPTED");
    expect(inviteTransition("PENDING", "revoke")).toBe("REVOKED");
    expect(code(() => inviteTransition("ACCEPTED", "accept"))).toBe("invite_not_pending");
    expect(INVITE_TTL_MS).toBe(72 * 3_600_000);
  });
  it("masks phones", () => {
    expect(maskPhone("+201012345678")).toBe("+20********78");
    expect(maskPhone("+2")).toBe("***");
  });
  it("only an owner changes roles and the last owner stays", () => {
    const members = [
      { userId: "o1", role: "owner" as const },
      { userId: "m1", role: "manager" as const },
    ];
    expect(code(() => assertCanChangeMember({ actorRole: "manager", members, targetUserId: "m1", newRole: "catalog" }))).toBe("owner_only");
    expect(code(() => assertCanChangeMember({ actorRole: "owner", members, targetUserId: "o1", newRole: "manager" }))).toBe("last_owner");
    expect(code(() => assertCanChangeMember({ actorRole: "owner", members, targetUserId: "o1", newRole: null }))).toBe("last_owner");
    expect(code(() => assertCanChangeMember({ actorRole: "owner", members, targetUserId: "zz", newRole: null }))).toBe("member_not_found");
    expect(code(() => assertCanChangeMember({ actorRole: "owner", members, targetUserId: "m1", newRole: null }))).toBe("no_error");
    const two = [...members, { userId: "o2", role: "owner" as const }];
    expect(code(() => assertCanChangeMember({ actorRole: "owner", members: two, targetUserId: "o1", newRole: "manager" }))).toBe("no_error");
  });
});

describe("notification prefs", () => {
  it("transactional events keep in_app, account_security keeps email", () => {
    const d = defaultPrefs();
    expect(d.new_order.in_app).toBe(true);
    expect(d.marketing_tips.push).toBe(false);
    expect(applyPrefUpdate(d, { new_order: { push: false, sms: true } }).new_order).toMatchObject({ push: false, sms: true, in_app: true });
    expect(code(() => applyPrefUpdate(d, { payout_sent: { in_app: false } }))).toBe("transactional_cannot_be_disabled");
    expect(code(() => applyPrefUpdate(d, { account_security: { email: false } }))).toBe("transactional_cannot_be_disabled");
    expect(applyPrefUpdate(d, { marketing_tips: { in_app: false } }).marketing_tips.in_app).toBe(false);
    expect(code(() => applyPrefUpdate(d, { bogus: { in_app: true } } as never))).toBe("notification_event_unknown");
  });
});

describe("shipping profile", () => {
  const origin = {
    governorateCode: "EG-C",
    cityCode: "nasr-city",
    street: "10 Abbas El Akkad",
    building: null,
    landmark: "Next to City Stars",
    contactName: "Warehouse",
    contactPhoneE164: "+201012345678",
    pin: { lat: 30.05, lng: 31.3 },
  };
  it("validates origin, handling time and couriers", () => {
    expect(validateOrigin(origin).street).toBe("10 Abbas El Akkad");
    expect(code(() => validateOrigin({ ...origin, governorateCode: "Cairo" }))).toBe("origin_area_invalid");
    expect(code(() => validateOrigin({ ...origin, pin: { lat: 10, lng: 10 } }))).toBe("origin_pin_outside_egypt");
    expect(code(() => validateOrigin({ ...origin, landmark: "" }))).toBe("origin_landmark_required");
    expect(validateHandlingHours(48)).toBe(48);
    expect(code(() => validateHandlingHours(2))).toBe("handling_time_out_of_range");
    expect(code(() => validateHandlingHours(500))).toBe("handling_time_out_of_range");
    const prefs = validateCourierPreferences({ default: ["bosta", "aramex"], "EG-ALX": ["aramex"] });
    expect(courierOrderFor(prefs, "EG-ALX")).toEqual(["aramex"]);
    expect(courierOrderFor(prefs, "EG-C")).toEqual(["bosta", "aramex"]);
    expect(courierOrderFor({}, "EG-C")).toEqual(["bosta"]);
    expect(code(() => validateCourierPreferences({ default: ["bosta", "bosta"] }))).toBe("courier_list_invalid");
    expect(code(() => validateCourierPreferences({ default: ["fedex"] }))).toBe("courier_unknown");
    expect(code(() => validateCourierPreferences({ cairo: ["bosta"] }))).toBe("courier_governorate_invalid");
  });
});

describe("eta enrolment status", () => {
  it("moves only along the allowed edges", () => {
    expect(etaTransition("not_enrolled", "request")).toBe("pending_verification");
    expect(etaTransition("pending_verification", "verified")).toBe("verified");
    expect(etaTransition("pending_verification", "failed")).toBe("failed");
    expect(etaTransition("failed", "request")).toBe("pending_verification");
    expect(etaTransition("verified", "revoke")).toBe("revoked");
    expect(code(() => etaTransition("not_enrolled", "verified"))).toBe("eta_invalid_transition");
    expect(code(() => etaTransition("verified", "request"))).toBe("eta_invalid_transition");
  });
});
