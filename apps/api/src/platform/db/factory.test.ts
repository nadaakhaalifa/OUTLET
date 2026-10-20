import { describe, expect, it } from "vitest";
import { createPgDatabase } from "./factory";

describe("createPgDatabase", () => {
  it("builds lazily (no connection) and validates config at the boundary", async () => {
    const db = createPgDatabase({ connectionString: "postgres://app@127.0.0.1:1/none" });
    await db.destroy();
    expect(() => createPgDatabase({ connectionString: "" })).toThrow();
    expect(() => createPgDatabase({ connectionString: "x", max: 0 })).toThrow();
    expect(() => createPgDatabase({ connectionString: "x", bogus: 1 } as never)).toThrow();
  });
});
