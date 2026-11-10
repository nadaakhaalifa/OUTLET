import { describe, expect, it } from "vitest";
import { AdminAccessError } from "../src/index.js";

describe("AdminAccessError", () => {
  it("defaults the message to the code", () => {
    const e = new AdminAccessError("SELF_GRANT");
    expect(e.message).toBe("SELF_GRANT");
    expect(e.code).toBe("SELF_GRANT");
    expect(e.name).toBe("AdminAccessError");
    expect(e).toBeInstanceOf(Error);
  });
  it("keeps an explicit message", () => {
    expect(new AdminAccessError("NOT_FOUND", "no such grant").message).toBe("no such grant");
  });
});
