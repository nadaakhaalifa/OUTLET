import type { Category } from "../domain/dto.js";
import { notFound, validation } from "../domain/errors.js";
import { pageLimit } from "./cursor.js";
import { asPublic, makeEnv } from "./env.js";
import type { CatalogDeps, Env } from "./env.js";

interface Row {
  id: string;
  parent_id: string | null;
  code: string;
  path: string;
  depth: number;
  vertical: string;
  name: string;
  slug: string;
}

export interface CategoryNode extends Category {
  readonly children: CategoryNode[];
}

const COLS = `c.id, c.parent_id, c.code, c.path, c.depth, c.vertical, COALESCE(l.name, la.name) AS name, COALESCE(l.slug, la.slug) AS slug`;
const FROM = `FROM categories c
  JOIN market_categories mc ON mc.category_id = c.id AND mc.market_id = $1 AND mc.active
  JOIN category_labels la ON la.category_id = c.id AND la.locale = 'ar'
  LEFT JOIN category_labels l ON l.category_id = c.id AND l.locale = $2`;

const dto = (r: Row): Category => ({ id: r.id, parent_id: r.parent_id, code: r.code, path: r.path, depth: r.depth, vertical: r.vertical, name: r.name, slug: r.slug });

/** Category reads for one market. Arabic is the fallback label (every category has an AR label). Public, no tenant context. */
export class CategoryService {
  private readonly env: Env;
  constructor(deps: CatalogDeps) {
    this.env = makeEnv(deps);
  }

  /** Keyset page ordered by path (a tree walk order), at most 50 per page. */
  async list(opts: { locale?: "ar" | "en"; cursor?: string; limit?: number } = {}): Promise<{ items: Category[]; next_cursor: string | null }> {
    const limit = pageLimit(opts.limit);
    const after = decodeCursorPath(opts.cursor);
    return await asPublic(this.env, async (tx) => {
      const r = await tx.query<Row>(`SELECT ${COLS} ${FROM} WHERE c.active AND ($3::text IS NULL OR c.path > $3) ORDER BY c.path LIMIT $4`, [
        this.env.marketId,
        opts.locale ?? "ar",
        after ?? null,
        limit + 1,
      ]);
      const page = r.rows.slice(0, limit);
      const last = page[page.length - 1];
      return { items: page.map(dto), next_cursor: r.rows.length > limit && last !== undefined ? encodePath(last.path) : null };
    });
  }

  /** The whole visible tree for the market, nested (the taxonomy is small by design; the launch tree has 14 nodes). */
  async tree(locale: "ar" | "en" = "ar"): Promise<CategoryNode[]> {
    return await asPublic(this.env, async (tx) => {
      const r = await tx.query<Row>(`SELECT ${COLS} ${FROM} WHERE c.active ORDER BY c.depth, c.sort, c.path LIMIT 1000`, [this.env.marketId, locale]);
      const nodes = new Map<string, CategoryNode>();
      const roots: CategoryNode[] = [];
      for (const row of r.rows) {
        const node: CategoryNode = { ...dto(row), children: [] };
        nodes.set(row.id, node);
        const parent = row.parent_id === null ? undefined : nodes.get(row.parent_id);
        if (parent === undefined) roots.push(node);
        else parent.children.push(node);
      }
      return roots;
    });
  }

  async getByCode(code: string, locale: "ar" | "en" = "ar"): Promise<Category> {
    return await asPublic(this.env, async (tx) => {
      const r = await tx.query<Row>(`SELECT ${COLS} ${FROM} WHERE c.active AND c.code = $3`, [this.env.marketId, locale, code]);
      const row = r.rows[0];
      if (row === undefined) throw notFound("category");
      return dto(row);
    });
  }
}

const encodePath = (path: string): string => Buffer.from(path).toString("base64url");
const decodeCursorPath = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  const p = Buffer.from(raw, "base64url").toString("utf8");
  if (!/^[a-z0-9_/]{1,200}$/.test(p)) throw validation("invalid cursor");
  return p;
};
