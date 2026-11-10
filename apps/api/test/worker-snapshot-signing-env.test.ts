import { describe, expect, it } from "vitest";
import { parseWorkerEnv } from "../src/worker/config.js";

const base = { DATABASE_URL_WORKER: "postgres://w@localhost/db", DATABASE_URL_APP: "postgres://a@localhost/db" };
const good = Buffer.alloc(32, 4).toString("base64");

describe("worker env: ledger snapshot signing", () => {
  it("accepts unset (unsigned mode) and a valid key + id", () => {
    expect(parseWorkerEnv(base).LEDGER_SNAPSHOT_HMAC_KEY).toBeUndefined();
    expect(parseWorkerEnv({ ...base, LEDGER_SNAPSHOT_HMAC_KEY: good, LEDGER_SNAPSHOT_KEY_ID: "k1" }).LEDGER_SNAPSHOT_KEY_ID).toBe("k1");
  });
  it("rejects a partial pair or bad base64 without echoing the key", () => {
    expect(() => parseWorkerEnv({ ...base, LEDGER_SNAPSHOT_HMAC_KEY: good })).toThrow(/LEDGER_SNAPSHOT_HMAC_KEY/);
    try { parseWorkerEnv({ ...base, LEDGER_SNAPSHOT_HMAC_KEY: "%%%secret%%%", LEDGER_SNAPSHOT_KEY_ID: "k1" }); expect.unreachable(); } catch (e) { expect(String(e)).not.toContain("secret"); }
  });
});
