import { describe, expect, it } from "vitest";
import { assertRuntimeRole, contextClient, narrowContext, withDbContext } from "../src/index.js";
import { asRole, createTestClient, roleClient } from "../src/testing.js";

const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("contextClient / narrowContext / role branding", () => {
  it("contextClient binds the context for every query and transaction", async () => {
    const { client, close } = await createTestClient();
    const scoped = contextClient(roleClient(client, "outlet_auth"), { kind: "auth", marketId: "EG" });
    const one = await scoped.query<{ c: string }>("SELECT current_setting('app.ctx') AS c");
    expect(one.rows[0]?.c).toBe("auth");
    const inTx = await scoped.transaction((tx) => tx.query<{ m: string }>("SELECT current_setting('app.current_market_id') AS m"));
    expect(inTx.rows[0]?.m).toBe("EG");
    await close();
  });

  it("narrowContext sets only the user id and refuses to run without a context", async () => {
    const { client, close } = await createTestClient();
    await expect(client.transaction((tx) => narrowContext(tx, { userId: U1 }))).rejects.toThrow(/context bound first/);
    const r = await contextClient(client, { kind: "auth", marketId: "EG" }).transaction(async (tx) => {
      await narrowContext(tx, { userId: U1 });
      return tx.query<{ u: string; c: string; m: string }>("SELECT current_setting('app.current_user_id') AS u, current_setting('app.ctx') AS c, current_setting('app.current_market_id') AS m");
    });
    expect(r.rows[0]).toEqual({ u: U1, c: "auth", m: "EG" });
    await expect(contextClient(client, { kind: "auth", marketId: "EG" }).transaction((tx) => narrowContext(tx, { userId: "nope" }))).rejects.toThrow(/invalid userId/);
    await close();
  });

  it("a branded client cannot be used with a context its role may not use", async () => {
    const { client, close } = await createTestClient();
    const app = roleClient(client, "outlet_app");
    // @ts-expect-error outlet_app clients accept user/store contexts only; the unbranded overload must not let a worker context through
    const bad = withDbContext(app, { kind: "worker", marketId: "EG", job: "outbox.relay" }, () => Promise.resolve(1));
    await bad.catch(() => undefined);
    await close();
  });

  it("assertRuntimeRole(outlet_app) fails if the app role could UPDATE or DELETE ledger rows", async () => {
    const { client, close } = await createTestClient();
    await asRole(client, "outlet_app", (tx) => assertRuntimeRole(tx, "outlet_app")).catch(() => undefined);
    await client.query("GRANT UPDATE ON postings TO outlet_app");
    await expect(asRole(client, "outlet_app", (tx) => assertRuntimeRole(tx, "outlet_app"))).rejects.toThrow(/UPDATE,DELETE on postings/);
    await close();
  });
});
