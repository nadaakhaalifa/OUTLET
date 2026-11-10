import { describe, expect, it } from "vitest";
import { withTenant } from "../src/index.js";
import type { Queryable } from "../src/index.js";
import { createTestClient } from "../src/testing.js";

const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const S1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const read = (tx: Queryable) =>
  tx.query<{ ctx: string; u: string; s: string }>(
    "SELECT current_setting('app.ctx') AS ctx, current_setting('app.current_user_id', true) AS u, current_setting('app.current_store_id', true) AS s",
  );

describe("withTenant context selection", () => {
  it("store scope with a user id binds both ids under kind store", async () => {
    const { client, close } = await createTestClient();
    const r = await withTenant(client, { marketId: "EG", storeId: S1, userId: U1 }, read);
    expect(r.rows[0]).toEqual({ ctx: "store", u: U1, s: S1 });
    await close();
  });

  it("store scope without a user id leaves the user binding empty", async () => {
    const { client, close } = await createTestClient();
    const r = await withTenant(client, { marketId: "EG", storeId: S1 }, read);
    expect(r.rows[0]?.ctx).toBe("store");
    expect(r.rows[0]?.u ?? "").toBe("");
    await close();
  });

  it("user scope binds the user, and an omitted user id is empty rather than inherited", async () => {
    const { client, close } = await createTestClient();
    const a = await withTenant(client, { marketId: "EG", userId: U1 }, read);
    expect(a.rows[0]).toMatchObject({ ctx: "user", u: U1 });
    const b = await withTenant(client, { marketId: "EG" }, read);
    expect(b.rows[0]?.ctx).toBe("user");
    expect(b.rows[0]?.u ?? "").toBe("");
    await close();
  });
});
