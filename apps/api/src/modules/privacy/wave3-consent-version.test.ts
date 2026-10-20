import { describe, expect, it } from "vitest";
import { InMemoryConsentRepository } from "./adapters/in-memory";
import { UpdateConsents } from "./application/consents";
import { sequentialIds, START_MS } from "./test/fixtures";

const versions = Object.fromEntries(
  ["marketing_push", "marketing_whatsapp", "marketing_email", "analytics", "personalization", "budget_insights", "measurements", "location_precise", "cross_border_ml"].map((p) => [p, 2]),
) as ConstructorParameters<typeof UpdateConsents>[1];

describe("grant version bounds", () => {
  const mk = () => new UpdateConsents(new InMemoryConsentRepository(), versions, { now: () => new Date(START_MS) }, () => "ab".repeat(8), sequentialIds());
  it("rejects a future version, accepts the current one, and always accepts a withdrawal", async () => {
    const u = mk();
    expect((await u.execute({ userId: "u", ip: "1", changes: [{ purpose: "analytics", granted: true, version: 3 }] })).kind).toBe("unknown_version");
    expect((await u.execute({ userId: "u", ip: "1", changes: [{ purpose: "analytics", granted: true, version: 2 }] })).kind).toBe("ok");
    expect((await u.execute({ userId: "u", ip: "1", changes: [{ purpose: "analytics", granted: false, version: 9 }] })).kind).toBe("ok");
  });
});
