import { describe, expect, it } from "vitest";
import type { Actor } from "@outlet/policy";
import { StoreListResolver, storeIdsOf } from "./resolvers";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const actor = (grants: Actor["grants"]): Actor => ({ id: "u", status: "active", assurance: "basic", grants, tokenScopes: [] });

describe("seller invoice store authorisation", () => {
  it("keeps only stores with owner/manager/finance", () => {
    const a = actor([
      { kind: "brand", storeId: A, role: "owner" },
      { kind: "brand", storeId: B, role: "catalog" },
    ]);
    expect(storeIdsOf(a)).toEqual([A]);
  });
  it("resolves the first payout-capable store, not a catalog-only first grant", async () => {
    const a = actor([
      { kind: "brand", storeId: B, role: "catalog" },
      { kind: "brand", storeId: A, role: "finance" },
    ]);
    expect((await new StoreListResolver().resolve({ actor: a }))?.storeId).toBe(A);
  });
  it("catalog-only actor gets the nil store (403)", async () => {
    const a = actor([{ kind: "brand", storeId: B, role: "catalog" }]);
    expect(storeIdsOf(a)).toEqual([]);
    expect((await new StoreListResolver().resolve({ actor: a }))?.storeId).toBe("00000000-0000-0000-0000-000000000000");
  });
});
