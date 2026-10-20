import { Inject, Injectable } from "@nestjs/common";
import type { Resource } from "@outlet/policy";
import type { ResourceResolver } from "../../../platform/ports";
import type { ImportRepository, ProductRepository } from "../domain/ports";
import { UuidSchema } from "@outlet/validation";

/** Loads the product a seller route addresses so policy decides on its real tenant. Unknown or malformed id gives null (404). */
@Injectable()
export class ProductResolver implements ResourceResolver {
  constructor(@Inject("catalog.ProductRepository") private readonly products: ProductRepository) {}
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    const id = UuidSchema.safeParse(input.id);
    if (!id.success) return null;
    const p = await this.products.findById(id.data);
    return p === null ? null : { type: "store_product", id: p.id, storeId: p.storeId, state: "active" };
  }
}

@Injectable()
export class ImportResolver implements ResourceResolver {
  constructor(@Inject("catalog.ImportRepository") private readonly imports: ImportRepository) {}
  async resolve(input: { readonly id: string | undefined }): Promise<Resource | null> {
    const id = UuidSchema.safeParse(input.id);
    if (!id.success) return null;
    const r = await this.imports.find(id.data);
    return r === null ? null : { type: "store_product", id: r.id, storeId: r.storeId, state: "active" };
  }
}
