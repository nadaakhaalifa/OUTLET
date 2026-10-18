import { describe, expect, it } from "vitest";
import * as policy from "./index";

describe("public entry point", () => {
  it("re-exports the decision API and errors", () => {
    expect(typeof policy.assertValidRuleSet).toBe("function");
    expect(typeof policy.parseActor).toBe("function");
    expect(typeof policy.dbSessionContext).toBe("function");
    expect(policy.InvalidRuleSetError).toBeDefined();
  });
});
