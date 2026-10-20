import { describe, expect, it } from "vitest";
import { ANALYTICS_EVENT_NAMES, analyticsEvents, isAnalyticsEventName } from "./analytics-events";
import { DOMAIN_EVENT_NAMES, domainEvents, isDomainEventName } from "./domain-events";
import { InvalidEventNameError, InvalidPseudonymousIdError, InvalidPropertyNameError } from "./errors";
import * as f from "./fields";
import {
  FORBIDDEN_NAME_TOKENS,
  assertAnalyticsEventName,
  assertDomainEventName,
  assertPropertyName,
  isValidAnalyticsEventName,
  isValidDomainEventName,
  isValidPropertyName,
} from "./naming";
import { MAX_ARRAY_LENGTH, MAX_PROPERTY_COUNT, MAX_STRING_LENGTH, inspectProperties, isPiiSafe } from "./pii";
import type { PseudonymState, PseudonymStore } from "./pseudonym";
import {
  RotatingPseudonymousId,
  derivePseudonymousId,
  needsRotation,
  nextPseudonymState,
  pseudonymousIdSchema,
  pseudonymStateSchema,
  rotationEpoch,
} from "./pseudonym";
import { RETENTION_POLICIES } from "./retention";
import { renderTaxonomyTables } from "./taxonomy";
import { ConsentGatedTracker, createRecordingTransport } from "./tracker";
import { VALID_PROPS } from "./test-fixtures";
import type { ConsentPurpose } from "./purposes";

type z_ = { safeParse: (v: unknown) => { success: boolean } };
const accepts = (schema: z_, v: unknown): boolean => schema.safeParse(v).success;
const options = (e: { options: readonly string[] }): string[] => [...e.options];

// ---------------------------------------------------------------- fields
describe("field vocabularies are exact", () => {
  it("enums", () => {
    expect(options(f.world)).toEqual(["local", "global", "shop_everything", "my_stores"]);
    expect(options(f.onboardingStep)).toEqual([
      "auth", "age_attestation", "language", "consents", "style_vibes", "sizes", "favorite_brands", "budget",
      "notification_permission",
    ]);
    expect(options(f.wishlistIntent)).toEqual([
      "need", "want", "treat", "buy_later_this_month", "birthday", "eid_ramadan", "gift", "custom",
    ]);
    expect(options(f.paymentMethod)).toEqual([
      "card", "apple_pay", "meeza", "mobile_wallet", "instapay", "fawry", "installments", "store_credit",
      "gift_card", "cod",
    ]);
    expect(options(f.returnReason)).toEqual([
      "too_small", "too_large", "not_as_described", "defective", "changed_mind", "late", "wrong_item",
    ]);
    expect(options(f.plusPlan)).toEqual(["monthly", "yearly", "family", "student", "gift"]);
    expect(options(f.dropType)).toEqual([
      "public", "members_only", "flash_hour", "mystery_box", "price_ladder", "last_chance",
    ]);
    expect(options(f.refundRoute)).toEqual(["psp_original", "store_credit", "bank_transfer", "provider_cancellation"]);
    expect(options(f.coinSource)).toEqual([
      "purchase", "photo_review", "size_profile", "fit_feedback", "referral", "streak", "challenge",
    ]);
    expect(options(f.notificationChannel)).toEqual(["push", "in_app", "whatsapp", "sms", "email"]);
  });
  it("opaqueId length and charset", () => {
    expect(accepts(f.opaqueId, "a".repeat(8))).toBe(true);
    expect(accepts(f.opaqueId, "a".repeat(7))).toBe(false);
    expect(accepts(f.opaqueId, "a".repeat(64))).toBe(true);
    expect(accepts(f.opaqueId, "a".repeat(65))).toBe(false);
    expect(accepts(f.opaqueId, "Ab_-9Zz0")).toBe(true);
    expect(accepts(f.opaqueId, "abcdefg.")).toBe(false);
    expect(accepts(f.opaqueId, "abcdefg ")).toBe(false);
    expect(accepts(f.opaqueId, "xabcdefg\n")).toBe(false);
  });
  it("code", () => {
    expect(accepts(f.code, "a")).toBe(true);
    expect(accepts(f.code, "a".repeat(32))).toBe(true);
    expect(accepts(f.code, "a".repeat(33))).toBe(false);
    expect(accepts(f.code, "a_b9")).toBe(true);
    for (const bad of ["", "1a", "_a", "A", "aB", "a-b", "a b", "a\n"]) expect(accepts(f.code, bad)).toBe(false);
  });
  it("minorUnits", () => {
    for (const v of ["0", "1", "10", "999999999", "123456789"]) expect(accepts(f.minorUnits, v)).toBe(true);
    for (const v of ["", "01", "1000000000", "-1", "1.5", "1e3", " 1", "1 ", "abc"]) expect(accepts(f.minorUnits, v)).toBe(false);
    expect(accepts(f.minorUnits, 5)).toBe(false);
  });
  it("numeric bounds", () => {
    expect(accepts(f.smallCount, 0)).toBe(true);
    expect(accepts(f.smallCount, 10_000)).toBe(true);
    expect(accepts(f.smallCount, 10_001)).toBe(false);
    expect(accepts(f.smallCount, -1)).toBe(false);
    expect(accepts(f.smallCount, 1.5)).toBe(false);
    expect(accepts(f.positiveQuantity, 1)).toBe(true);
    expect(accepts(f.positiveQuantity, 99)).toBe(true);
    expect(accepts(f.positiveQuantity, 0)).toBe(false);
    expect(accepts(f.positiveQuantity, 100)).toBe(false);
    expect(accepts(f.positiveQuantity, 2.5)).toBe(false);
    expect(accepts(f.durationMs, 0)).toBe(true);
    expect(accepts(f.durationMs, 600_000)).toBe(true);
    expect(accepts(f.durationMs, 600_001)).toBe(false);
    expect(accepts(f.durationMs, -1)).toBe(false);
    expect(accepts(f.durationMs, 0.5)).toBe(false);
    expect(accepts(f.unitInterval, 0)).toBe(true);
    expect(accepts(f.unitInterval, 0.37)).toBe(true);
    expect(accepts(f.unitInterval, 1)).toBe(true);
    expect(accepts(f.unitInterval, 1.0001)).toBe(false);
    expect(accepts(f.unitInterval, -0.0001)).toBe(false);
  });
});

// ---------------------------------------------------------------- naming
describe("naming rules", () => {
  const TOKENS = [
    "email", "phone", "msisdn", "password", "passcode", "otp", "token", "secret", "ssn", "passport", "iban", "cvv",
    "cvc", "pan", "dob", "birthday", "birthdate", "birth", "firstname", "lastname", "fullname", "name", "nickname",
    "address", "street", "building", "apartment", "landmark", "lat", "lng", "lon", "latitude", "longitude", "gps",
    "ip", "photo", "selfie", "height", "weight", "bust", "waist", "hip", "chest", "inseam", "measurement",
    "measurements", "query", "text", "message", "comment", "note", "body",
  ];
  it("the forbidden token set is exactly the reviewed list", () => {
    expect([...FORBIDDEN_NAME_TOKENS].sort()).toEqual([...TOKENS].sort());
  });
  it("every forbidden token is rejected in every name kind, at any position", () => {
    for (const t of TOKENS) {
      expect(isValidAnalyticsEventName(`x_${t}`), t).toBe(false);
      expect(isValidAnalyticsEventName(`${t}_x`), t).toBe(false);
      expect(isValidPropertyName(t), t).toBe(false);
      expect(isValidPropertyName(`a_${t}_b`), t).toBe(false);
      expect(isValidDomainEventName(`order.${t}_x`), t).toBe(false);
      expect(isValidDomainEventName(`${t}.created`), t).toBe(false);
    }
    expect(isValidAnalyticsEventName("names_seen")).toBe(true); // tokens match whole words only
    expect(isValidPropertyName("filename")).toBe(true);
  });
  it("analytics event name shape and length", () => {
    expect(isValidAnalyticsEventName("ab")).toBe(false);
    expect(isValidAnalyticsEventName("abc")).toBe(true);
    const long = (n: number) => "a".repeat(n);
    expect(isValidAnalyticsEventName(long(64))).toBe(true);
    expect(isValidAnalyticsEventName(long(65))).toBe(false);
    for (const bad of ["Abc", "1abc", "abc_", "_abc", "a__b", "ab.c", "ab-c", "ab c", "abc\n"]) {
      expect(isValidAnalyticsEventName(bad), bad).toBe(false);
    }
    expect(isValidAnalyticsEventName("a1_b2_c3")).toBe(true);
    for (const nonString of [null, undefined, 5, {}, ["abc"]]) expect(isValidAnalyticsEventName(nonString)).toBe(false);
  });
  it("domain event name shape and length", () => {
    expect(isValidDomainEventName("a.b")).toBe(true);
    expect(isValidDomainEventName("order_group.paid")).toBe(true);
    expect(isValidDomainEventName("a")).toBe(false);
    expect(isValidDomainEventName("ab")).toBe(false);
    expect(isValidDomainEventName("a.b.c")).toBe(false);
    expect(isValidDomainEventName("order_paid")).toBe(false);
    expect(isValidDomainEventName(".b")).toBe(false);
    expect(isValidDomainEventName("a.")).toBe(false);
    expect(isValidDomainEventName("Order.paid")).toBe(false);
    expect(isValidDomainEventName("a.b\n")).toBe(false);
    const pad = (n: number) => `${"a".repeat(n)}.b`;
    expect(isValidDomainEventName(pad(78))).toBe(true); // 80 chars
    expect(isValidDomainEventName(pad(79))).toBe(false); // 81 chars
    for (const nonString of [null, undefined, 5, {}]) expect(isValidDomainEventName(nonString)).toBe(false);
  });
  it("property name shape and length", () => {
    expect(isValidPropertyName("a")).toBe(true);
    expect(isValidPropertyName("a".repeat(40))).toBe(true);
    expect(isValidPropertyName("a".repeat(41))).toBe(false);
    expect(isValidPropertyName("")).toBe(false);
    for (const bad of ["A", "1a", "a_", "a__b", "a.b", "a-b", "a\n"]) expect(isValidPropertyName(bad), bad).toBe(false);
    for (const nonString of [null, undefined, 5]) expect(isValidPropertyName(nonString)).toBe(false);
  });
  it("asserts return the name or throw typed errors with the documented text", () => {
    expect(assertAnalyticsEventName("app_open")).toBe("app_open");
    expect(assertDomainEventName("user.registered")).toBe("user.registered");
    expect(assertPropertyName("source")).toBe("source");
    expect(() => assertAnalyticsEventName("Bad")).toThrow(InvalidEventNameError);
    expect(() => assertAnalyticsEventName("Bad")).toThrow(
      'invalid analytics event name "Bad": expected snake_case, 3-64 chars, no PII-like token',
    );
    expect(() => assertDomainEventName("bad")).toThrow(InvalidEventNameError);
    expect(() => assertDomainEventName("bad")).toThrow(
      'invalid domain event name "bad": expected aggregate.action in snake_case, max 80 chars',
    );
    expect(() => assertPropertyName("Bad")).toThrow(InvalidPropertyNameError);
    expect(() => assertPropertyName("Bad")).toThrow(
      'invalid property name "Bad": expected snake_case, 1-40 chars, no PII-like token',
    );
  });
});

// ---------------------------------------------------------------- pii
describe("inspectProperties codes and paths", () => {
  const codes = (v: unknown) => inspectProperties(v).map((x) => `${x.path}:${x.code}`);
  it("rejects non-objects", () => {
    for (const v of [null, undefined, 5, "x", [], [1]]) expect(inspectProperties(v)).toEqual([{ path: "", code: "not_an_object" }]);
  });
  it("accepts clean bags, including boundary sizes", () => {
    expect(inspectProperties({})).toEqual([]);
    expect(inspectProperties({ a: "x", b: 1, c: true, d: null, e: ["a", 2] })).toEqual([]);
    expect(isPiiSafe({ a: "x".repeat(MAX_STRING_LENGTH) })).toBe(true);
    expect(isPiiSafe({ a: Array.from({ length: MAX_ARRAY_LENGTH }, (_, i) => i) })).toBe(true);
    const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
    expect(inspectProperties(many(MAX_PROPERTY_COUNT))).toEqual([]);
    expect(inspectProperties(many(MAX_PROPERTY_COUNT + 1))).toEqual([{ path: "", code: "too_many_properties" }]);
    expect(MAX_STRING_LENGTH).toBe(128);
    expect(MAX_ARRAY_LENGTH).toBe(50);
    expect(MAX_PROPERTY_COUNT).toBe(32);
  });
  it("flags bad and forbidden property names separately", () => {
    expect(codes({ Bad: 1 })).toEqual(["Bad:invalid_property_name"]);
    expect(codes({ "1a": 1 })).toEqual(["1a:invalid_property_name"]);
    expect(codes({ ["a".repeat(41)]: 1 })).toEqual([`${"a".repeat(41)}:invalid_property_name`]);
    expect(codes({ ["a".repeat(40)]: 1 })).toEqual([]);
    expect(codes({ email: "x" })).toEqual(["email:forbidden_property_name"]);
    expect(codes({ user_phone: 1 })).toEqual(["user_phone:forbidden_property_name"]);
  });
  it("string length", () => {
    expect(codes({ a: "x".repeat(129) })).toEqual(["a:string_too_long"]);
    // too long strings are not inspected further
    expect(codes({ a: `${"x".repeat(120)}@mail.example.com` })).toEqual(["a:string_too_long"]);
  });
  it("email, ip, coordinates, tokens", () => {
    expect(codes({ a: "me@example.com" })).toEqual(["a:email_like_value"]);
    expect(codes({ a: "me@example" })).toEqual([]);
    expect(codes({ a: "@example.com" })).toEqual([]);
    expect(codes({ a: "ip 10.0.0.1 here" })).toEqual(["a:ip_like_value"]);
    expect(codes({ a: "1.2.3" })).toEqual([]);
    expect(codes({ a: "1234.5.6.7" })).toEqual([]);
    expect(codes({ a: "30.0444,31.2357" })).toEqual(["a:coordinate_like_value"]);
    expect(codes({ a: "30.0444 ; 31.2357" })).toEqual(["a:coordinate_like_value"]);
    expect(codes({ a: "-30.0444,-31.2357" })).toEqual(["a:coordinate_like_value"]);
    expect(codes({ a: "30.04,31.23" })).toEqual([]);
    expect(codes({ a: "eyJhbGciOiJI.eyJzdWIiOiIx.sig" })).toEqual(["a:token_like_value"]);
    expect(codes({ a: "eyJab.cd" })).toEqual([]);
    expect(codes({ a: "Bearer abc123" })).toEqual(["a:token_like_value"]);
    expect(codes({ a: "BEARER abc" })).toEqual(["a:token_like_value"]);
    expect(codes({ a: "bearer" })).toEqual([]);
    expect(codes({ a: "xbearer abc" })).toEqual([]);
  });
  it("reports several violations of one value in a fixed order", () => {
    expect(codes({ a: "me@example.com 10.0.0.1" })).toEqual(["a:email_like_value", "a:ip_like_value"]);
  });
  it("phone-like digit runs with separators and Arabic digits", () => {
    expect(codes({ a: "01001234567" })).toEqual(["a:phone_like_value"]);
    expect(codes({ a: "0100 123 4567" })).toEqual(["a:phone_like_value"]);
    expect(codes({ a: "(010) 0123-4567" })).toEqual(["a:phone_like_value"]);
    expect(codes({ a: "010.0123.4567" })).toEqual(["a:phone_like_value"]);
    expect(codes({ a: "٠١٠٠١٢٣٤٥٦٧" })).toEqual(["a:phone_like_value"]);
    expect(codes({ a: "۰۱۰۰۱۲۳۴۵۶۷" })).toEqual(["a:phone_like_value"]);
    expect(codes({ a: "123456789" })).toEqual([]);
    expect(codes({ a: "1234 5678 9" })).toEqual([]);
    expect(codes({ a: "1234567890" })).toEqual(["a:phone_like_value"]);
    expect(codes({ a: "order 12 of 34" })).toEqual([]);
    // Arabic digits are normalised before the other patterns run
    expect(codes({ a: "١٩٢.١٦٨.٠.١" })).toEqual(["a:ip_like_value"]);
    expect(codes({ a: "٣٠.٠٤٤٤,٣١.٢٣٥٧" })).toEqual(["a:coordinate_like_value"]);
  });
  it("UUIDs and ULIDs are exempt from the digit-run rule, case-insensitively for UUIDs", () => {
    expect(codes({ a: "12345678-1234-1234-1234-123456789012" })).toEqual([]);
    expect(codes({ a: "ABCDEF12-1234-1234-1234-123456789012" })).toEqual([]);
    expect(codes({ a: "01234567890123456789ABCDEF" })).toEqual([]);
    expect(codes({ a: "01234567890123456789abcdef" })).toEqual(["a:phone_like_value"]);
    expect(codes({ a: "x12345678-1234-1234-1234-123456789012" })).toEqual(["a:phone_like_value"]);
    expect(codes({ a: "12345678-1234-1234-1234-123456789012x" })).toEqual(["a:phone_like_value"]);
  });
  it("numbers and other scalar types", () => {
    expect(codes({ a: NaN })).toEqual(["a:unsupported_value_type"]);
    expect(codes({ a: Infinity })).toEqual(["a:unsupported_value_type"]);
    expect(codes({ a: 1_000_000_000 })).toEqual(["a:phone_like_value"]);
    expect(codes({ a: -1_000_000_000 })).toEqual(["a:phone_like_value"]);
    expect(codes({ a: 999_999_999 })).toEqual([]);
    expect(codes({ a: 1_000_000_000.5 })).toEqual([]);
    expect(codes({ a: 0 })).toEqual([]);
    expect(codes({ a: undefined })).toEqual(["a:unsupported_value_type"]);
    expect(codes({ a: () => 1 })).toEqual(["a:unsupported_value_type"]);
    expect(codes({ a: 5n })).toEqual(["a:unsupported_value_type"]);
    expect(codes({ a: Symbol("s") })).toEqual(["a:unsupported_value_type"]);
    expect(codes({ a: false, b: null })).toEqual([]);
  });
  it("arrays and nesting", () => {
    expect(codes({ a: Array.from({ length: 51 }, () => 1) })).toEqual(["a:array_too_long"]);
    expect(codes({ a: [1, { x: 1 }, [2]] })).toEqual(["a[1]:nested_value", "a[2]:nested_value"]);
    expect(codes({ a: ["ok", "me@example.com"] })).toEqual(["a[1]:email_like_value"]);
    expect(codes({ a: [NaN] })).toEqual(["a[0]:unsupported_value_type"]);
    expect(codes({ a: { x: 1 } })).toEqual(["a:nested_value"]);
    expect(codes({ a: [null] })).toEqual([]);
    expect(isPiiSafe({ a: { x: 1 } })).toBe(false);
    expect(isPiiSafe({ a: 1 })).toBe(true);
  });
});

// ---------------------------------------------------------------- catalogs
describe("catalog classification and guards", () => {
  const order = { P0: 0, P1: 1, P2: 2 } as const;
  it("analytics events: piiClass is P1 iff any property is P1", () => {
    for (const n of ANALYTICS_EVENT_NAMES) {
      const d = analyticsEvents[n];
      const expected = Object.values(d.classes).includes("P1" as never) ? "P1" : "P0";
      expect(d.piiClass, n).toBe(expected);
      expect(d.name).toBe(n);
    }
    expect(analyticsEvents.app_open.piiClass).toBe("P0");
    expect(analyticsEvents.world_selected.piiClass).toBe("P1");
  });
  it("analytics events: strict schema and name guard", () => {
    expect(analyticsEvents.app_open.schema.safeParse({ ...VALID_PROPS.app_open, extra: 1 }).success).toBe(false);
    expect(isAnalyticsEventName("app_open")).toBe(true);
    expect(isAnalyticsEventName("toString")).toBe(false);
    expect(isAnalyticsEventName("nope")).toBe(false);
    expect(isAnalyticsEventName({ toString: () => "app_open" })).toBe(false);
    expect(isAnalyticsEventName(5)).toBe(false);
  });
  it("domain events: piiClass is the highest field class, purpose and retention fixed", () => {
    for (const n of DOMAIN_EVENT_NAMES) {
      const d = domainEvents[n];
      const max = (Object.values(d.classes) as ("P0" | "P1" | "P2")[]).reduce<"P0" | "P1" | "P2">(
        (m, c) => (order[c] > order[m] ? c : m),
        "P0",
      );
      expect(d.piiClass, n).toBe(max);
      expect(d.purpose).toBe("strictly_necessary");
      expect(d.outboxRetention).toBe("outbox_published_30d_verify");
      expect(d.name).toBe(n);
    }
    expect(domainEvents["refund.completed"].piiClass).toBe("P2");
    expect(DOMAIN_EVENT_NAMES.some((n) => domainEvents[n].piiClass === "P1")).toBe(true);
  });
  it("domain events: strict schema and name guard", () => {
    expect(domainEvents["refund.completed"].schema.safeParse({ extra: 1 }).success).toBe(false);
    expect(isDomainEventName("refund.completed")).toBe(true);
    expect(isDomainEventName("toString")).toBe(false);
    expect(isDomainEventName("nope.nope")).toBe(false);
    expect(isDomainEventName({ toString: () => "refund.completed" })).toBe(false);
    expect(isDomainEventName(null)).toBe(false);
    expect(isDomainEventName(5)).toBe(false);
  });
});

// ---------------------------------------------------------------- taxonomy
describe("renderTaxonomyTables", () => {
  const t = renderTaxonomyTables();
  it("analytics table has the exact header and one row per event", () => {
    const lines = t.analytics.split("\n");
    expect(lines[0]).toBe(
      "| Event | Owner | Origin | Purpose required | Properties | PII class per property | Retention | Spec |",
    );
    expect(lines[1]).toBe("|---|---|---|---|---|---|---|---|");
    expect(lines).toHaveLength(ANALYTICS_EVENT_NAMES.length + 2);
    expect(lines[2]).toBe(
      "| `app_open` | app-shell | client | `analytics` | `launch_type`, `source` | launch_type=P0, source=P0 | `analytics_25m` | §26 |",
    );
    expect(t.analytics).toContain("`world`, `previous_world?`");
    expect(t.analytics).toContain("world=P1, previous_world=P1");
  });
  it("domain table has the exact header, mirrors and optional markers", () => {
    const lines = t.domain.split("\n");
    expect(lines[0]).toBe(
      "| Event | Version | Aggregate | Owner | Payload | PII class per field | Max class | Purpose | Record retention | Analytics mirror | Spec |",
    );
    expect(lines[1]).toBe("|---|---|---|---|---|---|---|---|---|---|---|");
    expect(lines).toHaveLength(DOMAIN_EVENT_NAMES.length + 2);
    const refund = lines.find((l) => l.startsWith("| `refund.completed`"));
    expect(refund).toBe(
      "| `refund.completed` | 1 | refund | refunds | `refund_id`, `user_id`, `order_group_id`, `route`, `amount_minor` | refund_id=P1, user_id=P2, order_group_id=P1, route=P1, amount_minor=P1 | P2 | `strictly_necessary` | `financial_tax_period_verify` | `refund_completed` | §15.6, §22 |",
    );
    expect(t.domain).toContain("`sku_id?`");
    expect(lines.some((l) => / \| none \| [^|]+ \|$/.test(l))).toBe(true);
  });
  it("retention table lists every policy with its verify flag", () => {
    const lines = t.retention.split("\n");
    expect(lines[0]).toBe("| Retention id | Meaning | Verify before launch |");
    expect(lines[1]).toBe("|---|---|---|");
    expect(lines).toHaveLength(Object.keys(RETENTION_POLICIES).length + 2);
    expect(lines[2]).toBe(`| \`analytics_25m\` | ${RETENTION_POLICIES.analytics_25m.description} | no |`);
    expect(lines[3]).toContain("| yes |");
  });
});

// ---------------------------------------------------------------- tracker
describe("tracker details", () => {
  const PX = `px_${"a".repeat(24)}`;
  const build = (opts: { granted?: boolean; px?: string; consent?: (p: ConsentPurpose) => boolean } = {}) => {
    const transport = createRecordingTransport();
    const tracker = new ConsentGatedTracker({
      origin: "client",
      consent: { isGranted: opts.consent ?? (() => opts.granted ?? true) },
      transport,
      clock: { now: () => new Date("2026-10-10T12:00:00Z") },
      ids: { next: () => "evt_1" },
      pseudonymousId: { current: () => opts.px ?? PX },
    });
    return { tracker, transport };
  };
  it("invalid properties report the failing paths", async () => {
    const { tracker, transport } = build();
    const r = await tracker.track("product_viewed", { ...VALID_PROPS.product_viewed, position: -1 });
    expect(r).toEqual({ status: "dropped", reason: "invalid_properties", detail: ["position"] });
    expect(transport.sent).toHaveLength(0);
  });
  it("PII-like values that pass the schema are dropped with path:code detail", async () => {
    const { tracker, transport } = build();
    const r = await tracker.track("product_viewed", { ...VALID_PROPS.product_viewed, product_id: "1234567890" });
    expect(r).toEqual({ status: "dropped", reason: "pii_policy_violation", detail: ["product_id:phone_like_value"] });
    expect(transport.sent).toHaveLength(0);
  });
  it("consent is checked before the schema, so a denied event with bad properties says consent", async () => {
    const { tracker } = build({ granted: false });
    expect(await tracker.track("product_viewed", { nope: 1 })).toEqual({
      status: "dropped",
      reason: "consent_not_granted",
    });
  });
  it("consent withdrawn between the two checks drops the event", async () => {
    let calls = 0;
    const { tracker, transport } = build({ consent: () => ++calls === 1 });
    expect(await tracker.track("app_open", VALID_PROPS.app_open)).toEqual({
      status: "dropped",
      reason: "consent_not_granted",
    });
    expect(calls).toBe(2);
    expect(transport.sent).toHaveLength(0);
  });
  it("the pseudonymous id must be exactly px_ plus 16-64 url-safe characters", async () => {
    for (const bad of [`px_${"a".repeat(15)}`, `px_${"a".repeat(65)}`, `xpx_${"a".repeat(20)}`, `px_${"a".repeat(20)}!`, `px_${"a".repeat(20)}\n`]) {
      const { tracker, transport } = build({ px: bad });
      expect(await tracker.track("app_open", VALID_PROPS.app_open)).toEqual({
        status: "dropped",
        reason: "invalid_pseudonymous_id",
      });
      expect(transport.sent).toHaveLength(0);
    }
    for (const good of [`px_${"a".repeat(16)}`, `px_${"A_-9".repeat(16)}`]) {
      const { tracker } = build({ px: good });
      expect((await tracker.track("app_open", VALID_PROPS.app_open)).status).toBe("sent");
    }
  });
});

// ---------------------------------------------------------------- pseudonym
describe("pseudonym details", () => {
  const at = new Date("2026-06-01T00:00:00Z");
  it("schemas are anchored and bounded", () => {
    expect(accepts(pseudonymousIdSchema, `px_${"a".repeat(16)}`)).toBe(true);
    expect(accepts(pseudonymousIdSchema, `px_${"a".repeat(64)}`)).toBe(true);
    expect(accepts(pseudonymousIdSchema, `px_${"a".repeat(15)}`)).toBe(false);
    expect(accepts(pseudonymousIdSchema, `px_${"a".repeat(65)}`)).toBe(false);
    expect(accepts(pseudonymousIdSchema, `xpx_${"a".repeat(20)}`)).toBe(false);
    expect(accepts(pseudonymousIdSchema, `px_${"a".repeat(20)}!`)).toBe(false);
    const id = `px_${"a".repeat(20)}`;
    expect(accepts(pseudonymStateSchema, { id, epoch: 2000 })).toBe(true);
    expect(accepts(pseudonymStateSchema, { id, epoch: 9999 })).toBe(true);
    expect(accepts(pseudonymStateSchema, { id, epoch: 1999 })).toBe(false);
    expect(accepts(pseudonymStateSchema, { id, epoch: 10000 })).toBe(false);
    expect(accepts(pseudonymStateSchema, { id, epoch: 2026.5 })).toBe(false);
    expect(accepts(pseudonymStateSchema, { id, epoch: 2026, extra: 1 })).toBe(false);
  });
  it("rotation by UTC calendar year, including a clock moved backwards", () => {
    const st: PseudonymState = { id: `px_${"a".repeat(20)}`, epoch: 2026 };
    expect(rotationEpoch(new Date("2026-12-31T23:59:59Z"))).toBe(2026);
    expect(needsRotation(st, new Date("2026-12-31T23:59:59Z"))).toBe(false);
    expect(needsRotation(st, new Date("2027-01-01T00:00:00Z"))).toBe(true);
    expect(needsRotation(st, new Date("2025-06-01T00:00:00Z"))).toBe(true);
    expect(nextPseudonymState(st, at, () => "zzzzzzzzzzzzzzzzzzzz")).toBe(st);
    expect(nextPseudonymState(undefined, at, () => "b".repeat(20))).toEqual({ id: `px_${"b".repeat(20)}`, epoch: 2026 });
    expect(nextPseudonymState(st, new Date("2027-02-01T00:00:00Z"), () => "c".repeat(20))).toEqual({
      id: `px_${"c".repeat(20)}`,
      epoch: 2027,
    });
    expect(() => nextPseudonymState(undefined, at, () => "short")).toThrow(InvalidPseudonymousIdError);
    expect(() => nextPseudonymState(undefined, at, () => "short")).toThrow(
      "id generator produced an id that is not px_ + 16-64 URL-safe characters",
    );
  });
  it("the rotating provider writes only when the state changed", () => {
    let stored: unknown;
    const writes: PseudonymState[] = [];
    const store: PseudonymStore = {
      read: () => stored,
      write: (s) => {
        writes.push(s);
        stored = s;
      },
      clear: () => {
        stored = undefined;
      },
    };
    let n = 0;
    const p = new RotatingPseudonymousId({
      clock: { now: () => at },
      ids: { next: () => `${String(++n).padStart(2, "0")}${"d".repeat(18)}` },
      store,
    });
    const first = p.current();
    expect(first).toBe(`px_01${"d".repeat(18)}`);
    expect(writes).toHaveLength(1);
    expect(p.current()).toBe(first);
    expect(writes).toHaveLength(1); // unchanged state is not rewritten
    stored = { id: "garbage", epoch: 2026 }; // invalid persisted state is discarded and replaced
    const second = p.current();
    expect(second).toBe(`px_02${"d".repeat(18)}`);
    expect(writes).toHaveLength(2);
    p.reset();
    expect(stored).toBeUndefined();
    expect(p.current()).toBe(`px_03${"d".repeat(18)}`);
    expect(writes).toHaveLength(3);
  });
  it("derivePseudonymousId derives from the epoch and key, never embeds the key", () => {
    const seen: string[] = [];
    const hmac = (m: string): string => {
      seen.push(m);
      return "0123456789abcdef".repeat(4);
    };
    const id = derivePseudonymousId("user-1", at, hmac);
    expect(seen).toEqual(["pseudonym:v1:2026:user-1"]);
    expect(id).toBe(`px_${"0123456789abcdef".repeat(2)}`);
    expect(id).toHaveLength(35);
    expect(() => derivePseudonymousId("", at, hmac)).toThrow("userKey must not be empty");
    expect(() => derivePseudonymousId("u", at, () => "abc")).toThrow(
      "hmac output is too short or contains unsafe characters",
    );
    expect(() => derivePseudonymousId("u", at, () => "!".repeat(40))).toThrow(InvalidPseudonymousIdError);
  });
});
