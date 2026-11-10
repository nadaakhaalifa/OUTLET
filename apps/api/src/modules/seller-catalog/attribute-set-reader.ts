import { withDbContext } from "@outlet/db";
import type { RoleSqlClient } from "@outlet/db";
import { notFound } from "@outlet/catalog";
import { AttributeSetResult } from "./dto.js";

export interface AttributeSetPort {
  forCategory(categoryId: string): Promise<AttributeSetResult>;
}

interface Row {
  code: string;
  data_type: "enum" | "text" | "number" | "boolean" | "size_run";
  unit: string | null;
  enum_values: { code: string; label_ar: string; label_en?: string }[] | null;
  required: boolean;
}

/** Reference data (attribute sets are platform-owned, read-only for the app role): same lookup the listing service validates against. */
export class AttributeSetReader implements AttributeSetPort {
  constructor(private readonly deps: { client: RoleSqlClient<"outlet_app">; marketId: string }) {}

  async forCategory(categoryId: string): Promise<AttributeSetResult> {
    return await withDbContext(this.deps.client, { kind: "user", marketId: this.deps.marketId }, async (tx) => {
      const usable = await tx.query(
        "SELECT 1 FROM categories c JOIN market_categories mc ON mc.category_id = c.id AND mc.market_id = $2 AND mc.active WHERE c.id = $1 AND c.active",
        [categoryId, this.deps.marketId],
      );
      if (usable.rows.length === 0) throw notFound("category");
      const r = await tx.query<Row>(
        `SELECT ai.attribute_code AS code, ad.data_type, ad.unit, ad.enum_values, ai.required
           FROM (SELECT a.attribute_set_id AS sid
                   FROM categories c
                   JOIN categories a ON a.attribute_set_id IS NOT NULL AND (c.path = a.path OR starts_with(c.path, a.path || '/'))
                  WHERE c.id = $1 ORDER BY a.depth DESC LIMIT 1) s
           JOIN attribute_set_items ai ON ai.attribute_set_id = s.sid
           JOIN attribute_definitions ad ON ad.code = ai.attribute_code
          ORDER BY ai.attribute_code`,
        [categoryId],
      );
      const defects = await tx.query<{ code: string; label_ar: string; label_en: string | null; default_severity: "minor" | "major" }>(
        `SELECT t.code, t.label_ar, t.label_en, t.default_severity
           FROM defect_types t
          WHERE t.active AND NOT t.is_critical AND (t.vertical IS NULL OR t.vertical = (SELECT vertical FROM categories WHERE id = $1))
          ORDER BY t.code`,
        [categoryId],
      );
      return AttributeSetResult.parse({
        category_id: categoryId,
        attributes: r.rows.map((x) => ({ code: x.code, data_type: x.data_type, unit: x.unit, options: (x.enum_values ?? []).map((v: { code: string; label_ar: string; label_en?: string }) => ({ code: v.code, label_ar: v.label_ar, label_en: v.label_en ?? null })), required: x.required })),
        defect_types: defects.rows,
      });
    });
  }
}
