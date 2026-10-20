import { describe, expect, it } from "vitest";

// Catalog modules run validation at import time. Importing them dynamically inside a test makes a mutant
// that breaks module initialisation fail a test instead of silently failing every file that imports it.
describe("modules load", () => {
  it("initialise the catalogs", async () => {
    const a = await import("./analytics-events.js");
    const d = await import("./domain-events.js");
    const n = await import("./naming.js");
    const f = await import("./fields.js");
    const r = await import("./retention.js");
    const t = await import("./taxonomy.js");
    const ps = await import("./pseudonym.js");
    expect(a.ANALYTICS_EVENT_NAMES.length).toBeGreaterThan(30);
    expect(d.DOMAIN_EVENT_NAMES.length).toBeGreaterThan(10);
    expect(n.FORBIDDEN_NAME_TOKENS.size).toBeGreaterThan(40);
    expect(f.world.options).toHaveLength(4);
    expect(Object.keys(r.RETENTION_POLICIES)).toHaveLength(6);
    expect(t.renderTaxonomyTables().analytics.length).toBeGreaterThan(100);
    expect(ps.pseudonymousIdSchema.safeParse("px_aaaaaaaaaaaaaaaa").success).toBe(true);
  });
});
