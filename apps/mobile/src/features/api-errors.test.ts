import { describe, expect, it } from "vitest";
import { resources } from "../../../../packages/i18n/src/index";
import { errorKeyFor } from "./api-errors";
import type { ApiErrorCode } from "../api/port";

function lookup(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

describe("errorKeyFor", () => {
  const codes: ApiErrorCode[] = ["network", "unavailable", "rate_limited", "invalid_code", "code_expired", "country_not_supported", "age_not_eligible", "deletion_blocked", "unauthenticated"];
  it("always resolves to an existing string in both languages", () => {
    for (const c of codes) {
      for (const ctx of ["otp", "general"] as const) {
        const key = errorKeyFor(c, ctx);
        expect(typeof lookup(resources.ar, key)).toBe("string");
        expect(typeof lookup(resources.en, key)).toBe("string");
      }
    }
  });
});
