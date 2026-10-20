import { describe, expect, it } from "vitest";
import { dbSessionContext } from "./db-context";
import { MalformedAuthzInputError } from "./errors";
import { parseActor } from "./parse";
import { actor } from "./test-fixtures";

const base = { id: "u", status: "active", assurance: "basic", tokenScopes: [] };

describe("brand_permission at the boundaries", () => {
  it("parses a brand_permission grant and rejects malformed ones", () => {
    const a = parseActor({ ...base, grants: [{ kind: "brand_permission", storeId: "s1", permissions: ["stock.read"] }] });
    expect(a.grants[0]).toEqual({ kind: "brand_permission", storeId: "s1", permissions: ["stock.read"] });
    expect(() => parseActor({ ...base, grants: [{ kind: "brand_permission", storeId: "s1", permissions: "x" }] })).toThrow(MalformedAuthzInputError);
    expect(() => parseActor({ ...base, grants: [{ kind: "brand_permission", storeId: "s1", permissions: [1] }] })).toThrow(MalformedAuthzInputError);
    expect(() => parseActor({ ...base, grants: [{ kind: "brand_permission", storeId: "", permissions: [] }] })).toThrow(MalformedAuthzInputError);
    expect(() => parseActor({ ...base, grants: [{ kind: "brand_permission", storeId: "s1", permissions: Array.from({ length: 65 }, () => "a") }] })).toThrow(MalformedAuthzInputError);
  });
  it("RLS storeIds include brand_permission stores, deduplicated and sorted", () => {
    const a = actor("u", [
      { kind: "brand_permission", storeId: "s2", permissions: [] },
      { kind: "brand", storeId: "s1", role: "support" },
      { kind: "brand_permission", storeId: "s1", permissions: [] },
    ]);
    expect(dbSessionContext(a, { kind: "seller" }, 0)).toEqual({ userId: "u", role: "seller", storeIds: ["s1", "s2"] });
  });
});
