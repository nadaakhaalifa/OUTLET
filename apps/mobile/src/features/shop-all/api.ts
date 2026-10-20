import { dataOf } from "../../services/api-client";
import { guard, type AdapterContext } from "../../services/wire";
import type { CategoryNode, CategoryPort } from "./model";

/**
 * GET /v1/public/categories (anonymous route, token optional). The wire is flat with `parent_id` and an
 * explicit sibling `position`; nodes are ordered by (parent, position) so the sheet is stable. English
 * is optional on the wire and falls back to Arabic. `return_class` is not needed by the filter.
 */
export class ApiCategoryPort implements CategoryPort {
  constructor(private readonly ctx: AdapterContext) {}

  tree(): Promise<readonly CategoryNode[]> {
    return guard(async () => {
      const res = dataOf(await this.ctx.client.listPublicCategories());
      const items = [...res.items].sort((a, b) => {
        const pa = a.parent_id ?? "";
        const pb = b.parent_id ?? "";
        return pa === pb ? a.position - b.position : pa < pb ? -1 : 1;
      });
      return items.map((c): CategoryNode => ({
        id: c.id,
        slug: c.slug,
        nameAr: c.name.ar,
        nameEn: c.name.en ?? c.name.ar,
        parentId: c.parent_id,
      }));
    });
  }
}
