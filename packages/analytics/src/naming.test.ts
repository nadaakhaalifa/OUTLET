import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { InvalidEventNameError, InvalidPropertyNameError } from "./errors";
import {
  assertAnalyticsEventName,
  assertDomainEventName,
  assertPropertyName,
  isValidAnalyticsEventName,
  isValidDomainEventName,
  isValidPropertyName,
} from "./naming";

describe("analytics event names", () => {
  it.each(["app_open", "add_to_bag", "plus_started", "search_no_result"])("accepts %s", (n) => {
    expect(isValidAnalyticsEventName(n)).toBe(true);
  });
  it.each(["AppOpen", "app-open", "app open", "order.placed", "_x_y", "x__y", "ab", "", "user_email_entered", "x_phone_y", "1abc"])(
    "rejects %j",
    (n) => {
      expect(isValidAnalyticsEventName(n)).toBe(false);
    },
  );
  it("rejects non-strings and over-long names", () => {
    expect(isValidAnalyticsEventName(42)).toBe(false);
    expect(isValidAnalyticsEventName(undefined)).toBe(false);
    expect(isValidAnalyticsEventName("a".repeat(65))).toBe(false);
  });
  it("assert throws a typed error", () => {
    expect(() => assertAnalyticsEventName("Bad Name")).toThrow(InvalidEventNameError);
    expect(assertAnalyticsEventName("app_open")).toBe("app_open");
  });
});

describe("domain event names", () => {
  it.each(["user.registered", "order_group.placed", "price_claim.scored"])("accepts %s", (n) => {
    expect(isValidDomainEventName(n)).toBe(true);
  });
  it.each(["app_open", "a.b.c", "User.Registered", "user.", ".placed", "user.email_sent", "user..x"])("rejects %j", (n) => {
    expect(isValidDomainEventName(n)).toBe(false);
  });
  it("assert throws a typed error", () => {
    expect(() => assertDomainEventName("nodot")).toThrow(InvalidEventNameError);
  });
});

describe("property names", () => {
  it.each(["product_id", "total_minor", "x"])("accepts %s", (n) => expect(isValidPropertyName(n)).toBe(true));
  it.each(["productId", "email", "user_phone", "ip", "latitude", "a".repeat(41), "Query"])("rejects %j", (n) => {
    expect(isValidPropertyName(n)).toBe(false);
  });
  it("assert throws a typed error", () => {
    expect(() => assertPropertyName("email")).toThrow(InvalidPropertyNameError);
  });
  it("property: any name containing an uppercase letter or a dash is rejected", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z]{1,5}$/), fc.constantFrom("A", "-", " ", "."), fc.stringMatching(/^[a-z]{0,5}$/), (a, bad, b) => {
        expect(isValidPropertyName(`${a}${bad}${b}`)).toBe(false);
        expect(isValidAnalyticsEventName(`${a}${bad}${b}`)).toBe(false);
      }),
    );
  });
});
