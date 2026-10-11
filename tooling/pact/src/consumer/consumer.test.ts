import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOpenApi, responseDoc, validate } from "../openapi";
import { buildPact, writePact, type PactFile } from "../pact-dsl";
import { CONSUMER, MOBILE_INTERACTIONS, PROVIDER } from "./mobile-contracts";

const doc = loadOpenApi();
export const PACT_PATH = join(import.meta.dirname, "../../pacts", `${CONSUMER}-${PROVIDER}.json`);

describe("consumer: mobile expectations are generated and consistent with OpenAPI", () => {
  const pact: PactFile = buildPact(CONSUMER, PROVIDER, MOBILE_INTERACTIONS);

  it("writes a Pact v3 file", () => {
    writePact(PACT_PATH, pact);
    expect(pact.metadata.pactSpecification.version).toBe("3.0.0");
    expect(pact.interactions.length).toBe(MOBILE_INTERACTIONS.length);
    const names = pact.interactions.map((i) => i.description);
    expect(new Set(names).size).toBe(names.length);
  });

  it("covers auth, catalog, bag, checkout, orders, returns and privacy", () => {
    const paths = pact.interactions.map((i) => i.request.path).join(" ");
    for (const p of ["/v1/auth/", "/v1/products/", "/v1/cart", "/v1/checkout/quote", "/v1/order-groups/", "/v1/me/orders", "/v1/me/returns", "/v1/me/privacy/"]) {
      expect(paths).toContain(p);
    }
  });

  for (const [i, spec] of MOBILE_INTERACTIONS.entries()) {
    it(`expectation is valid against OpenAPI: ${spec.description}`, () => {
      const rd = responseDoc(doc, spec.openapi, spec.response.status);
      expect(rd, `OpenAPI declares no ${spec.response.status} for ${spec.openapi}`).not.toBeNull();
      const body = pact.interactions[i]?.response.body;
      if (rd?.schema !== undefined && rd.schema !== null && body !== undefined) {
        // The consumer subset must not contain fields the documented schema forbids or mistypes.
        const errs = validate(doc, rd.schema, body).filter((e) => !e.includes("required but missing"));
        expect(errs).toEqual([]);
      }
      if (rd !== null) {
        for (const h of Object.keys(spec.response.headers ?? {})) {
          const lower = h.toLowerCase();
          if (lower === "content-type") continue;
          expect(Object.keys(rd.headers), `header ${h} undocumented for ${spec.openapi} ${spec.response.status}`).toContain(lower);
        }
      }
    });
  }
});
