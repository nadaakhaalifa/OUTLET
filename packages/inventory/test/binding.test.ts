import { randomUUID } from "node:crypto";
import { OutboxWriter, pgTransactionalWriter } from "@outlet/outbox";
import { createTestClient, roleClient } from "@outlet/db/testing";
import { describe, expect, it } from "vitest";
import { inStoreContext } from "../src/application/binding.js";
import type { Env } from "../src/application/env.js";
import { InMemorySoldOutFlags } from "../src/testing.js";

const setting = async (tx: { query: (sql: string) => Promise<{ rows: { v: string | null }[] }> }, key: string): Promise<string | null> =>
  (await tx.query(`SELECT current_setting('${key}', true) AS v`)).rows[0]?.v ?? null;

describe("inStoreContext", () => {
  const withDb = async (fn: (tx: Parameters<typeof inStoreContext>[1], env: Env) => Promise<void>): Promise<void> => {
    const { client, close } = await createTestClient();
    try {
      await client.transaction(async (tx) => {
        await fn(tx, { client: roleClient(client, "outlet_app"), marketId: "EG", outbox: new OutboxWriter(pgTransactionalWriter), now: () => new Date(), newId: () => randomUUID(), soldOut: new InMemorySoldOutFlags(), poolCap: 10 });
      });
    } finally {
      await close();
    }
  };

  it("with no caller user the store context carries no user id, and everything is restored to empty afterwards", async () => {
    const store = randomUUID();
    await withDb(async (tx, env) => {
      const inside = await inStoreContext(env, tx, store, async () => ({ store: await setting(tx, "app.current_store_id"), user: await setting(tx, "app.current_user_id") }));
      expect(inside.store).toBe(store);
      expect(inside.user ?? "").toBe("");
      expect((await setting(tx, "app.current_store_id")) ?? "").toBe("");
    });
  });

  it("keeps the caller's user id inside the store context and restores both settings afterwards; the callback's value is returned", async () => {
    const store = randomUUID();
    const user = randomUUID();
    await withDb(async (tx, env) => {
      await tx.query("SELECT set_config('app.current_user_id', $1, true)", [user]);
      const out = await inStoreContext(env, tx, store, async () => `${String(await setting(tx, "app.current_store_id"))}|${String(await setting(tx, "app.current_user_id"))}`);
      expect(out).toBe(`${store}|${user}`);
      expect(await setting(tx, "app.current_user_id")).toBe(user);
      expect((await setting(tx, "app.current_store_id")) ?? "").toBe("");
    });
  });

  it("a failing callback propagates its error (the surrounding transaction rollback reverts the settings)", async () => {
    await withDb(async (tx, env) => {
      await expect(inStoreContext(env, tx, randomUUID(), () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    });
  });
});
