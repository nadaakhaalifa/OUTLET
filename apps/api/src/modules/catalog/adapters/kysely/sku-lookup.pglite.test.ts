import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STORE_A, STORE_B, makeProduct } from "../../test/contract/repositories.contract";
import { createCatalogPglite, type CatalogPglite } from "../../test/pglite-fixture";
import { KyselySkuLookup } from "./sku-lookup";

describe("KyselySkuLookup (pglite)", () => {
  let h: CatalogPglite;
  beforeAll(async () => {
    h = await createCatalogPglite();
  });
  afterAll(async () => {
    await h.close();
  });

  it("resolves seller SKUs within one store only and reads sku facts", async () => {
    const product = makeProduct(STORE_A, {
      skus: [
        { sellerSku: "ODOO-100", sizeLabel: "M", price: { amount: 129_900n, currency: "EGP" } },
        { sellerSku: "ODOO-101", sizeLabel: "L", price: { amount: 139_900n, currency: "EGP" } },
      ],
    });
    await h.products.insert(product);
    const lookup = new KyselySkuLookup(h.runner, h.session);

    const found = await lookup.bySellerSku(STORE_A, ["ODOO-100", "ODOO-101", "UNKNOWN"]);
    expect([...found.keys()].sort()).toEqual(["ODOO-100", "ODOO-101"]);
    // The same code asked for as another store resolves nothing: no cross-tenant read.
    expect((await lookup.bySellerSku(STORE_B, ["ODOO-100"])).size).toBe(0);
    expect((await lookup.bySellerSku(STORE_A, [])).size).toBe(0);
    expect((await lookup.bySellerSku("not-a-uuid", ["ODOO-100"])).size).toBe(0);

    const skuId = found.get("ODOO-100") ?? "";
    expect(await lookup.skuFacts(skuId)).toMatchObject({
      skuId,
      productId: product.id,
      storeId: STORE_A,
      sizeLabel: "M",
      priceAmount: 129_900n,
      currency: "EGP",
      skuStatus: "active",
      productStatus: "draft",
    });
    expect(await lookup.skuFacts("00000000-0000-4000-8000-00000000dead")).toBeNull();
  });
});
