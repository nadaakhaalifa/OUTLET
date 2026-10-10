import { describe, expect, it } from "vitest";
import { SearchUnavailableError } from "../domain/ports";
import { req } from "../test/index-contract";
import { TypesenseSearchPort } from "./typesense";

describe("TypesenseSearchPort stub", () => {
  it("without a transport reports unavailable (callers fall back to Postgres)", async () => {
    const p = new TypesenseSearchPort();
    await expect(p.search(req())).rejects.toBeInstanceOf(SearchUnavailableError);
    await expect(p.suggest("x", 5)).rejects.toBeInstanceOf(SearchUnavailableError);
  });

  it("maps any transport failure and timeout to SearchUnavailableError", async () => {
    const boom = new TypesenseSearchPort({
      search: async () => {
        throw new Error("ECONNRESET");
      },
      suggest: async () => [],
    });
    await expect(boom.search(req())).rejects.toBeInstanceOf(SearchUnavailableError);
    const slow = new TypesenseSearchPort({ search: () => new Promise(() => undefined), suggest: async () => [] }, 10);
    await expect(slow.search(req())).rejects.toBeInstanceOf(SearchUnavailableError);
  });

  it("passes through a healthy transport", async () => {
    const p = new TypesenseSearchPort({
      search: async () => ({ hits: [{ productId: "a", sponsored: false }], total: 1, degraded: false }),
      suggest: async () => ["q"],
    });
    expect((await p.search(req())).total).toBe(1);
    expect(await p.suggest("q", 1)).toEqual(["q"]);
  });
});
