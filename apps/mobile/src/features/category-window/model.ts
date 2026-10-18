/** Category window (round-2 item 2): bottom sheet of subcategories. Pure; counts come only from API values. */
import type { CategoryNode } from "../shop-all/model";

/** Exact per-category counts for the current world and store scope, from `facet_counts.category_ids`. Absent = no numbers. */
export type CategoryCounts = Readonly<Record<string, number>>;

export type WindowRow =
  | { readonly kind: "all"; readonly id: string; readonly count?: number }
  | { readonly kind: "child"; readonly id: string; readonly node: CategoryNode; readonly count?: number; readonly disabled: boolean };

/** A count is valid only as a finite non-negative integer supplied by the API; anything else renders as no number. */
export function validCount(counts: CategoryCounts | undefined, id: string): number | undefined {
  const n = counts?.[id];
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : undefined;
}

export function childrenOf(tree: readonly CategoryNode[], id: string): readonly CategoryNode[] {
  // Tree order is (parent, position) order from the API adapter, so siblings keep `position` order.
  return tree.filter((n) => n.parentId === id);
}

/** A node with no children opens Shop all directly (no sheet). */
export function opensDirectly(tree: readonly CategoryNode[], node: CategoryNode): boolean {
  return childrenOf(tree, node.id).length === 0;
}

/**
 * Rows: "See all in {name}" first, then the children. A child with a confirmed count of 0 stays visible but is disabled.
 * With no count the row has no number and stays enabled (never "0+", "many" or a guess).
 */
export function windowRows(tree: readonly CategoryNode[], node: CategoryNode, counts?: CategoryCounts): readonly WindowRow[] {
  const allCount = validCount(counts, node.id);
  const rows: WindowRow[] = [{ kind: "all", id: node.id, ...(allCount !== undefined ? { count: allCount } : {}) }];
  for (const child of childrenOf(tree, node.id)) {
    const count = validCount(counts, child.id);
    rows.push({ kind: "child", id: child.id, node: child, ...(count !== undefined ? { count } : {}), disabled: count === 0 });
  }
  return rows;
}

/** Route params for Shop all. A top-level node is also a department-less category filter; the caller adds `department` when it knows one. */
export function shopAllParams(node: CategoryNode, department?: string): Record<string, string> {
  return { category: node.id, ...(department !== undefined ? { department } : {}) };
}
