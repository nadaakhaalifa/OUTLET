import { Fragment, isValidElement, type ReactNode } from "react";

/** Host node produced by `expand`: a string-typed element with its expanded children. */
export interface HostNode { readonly type: string; readonly props: Record<string, unknown>; readonly children: readonly Out[] }
export type Out = HostNode | string | number;

interface Callable { (props: Record<string, unknown>): ReactNode }
interface Wrapped { render?: Callable; type?: unknown }

/**
 * Minimal deterministic renderer for hook-free-by-mock components: expands function components by calling them
 * (hooks are stubbed by the test) until only host (string-typed) elements remain. No clock, no native runtime.
 */
export function expand(node: ReactNode): Out[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [node];
  if (Array.isArray(node)) return node.flatMap((n: ReactNode) => expand(n));
  if (!isValidElement(node)) return [];
  const { type } = node;
  const props = node.props as Record<string, unknown>;
  if (type === Fragment) return expand(props["children"] as ReactNode);
  if (typeof type === "string") return [{ type, props, children: expand(props["children"] as ReactNode) }];
  if (typeof type === "function") return expand((type as Callable)(props));
  const w = type as Wrapped;
  if (typeof w.render === "function") return expand(w.render(props));
  if (w.type !== undefined) return expand({ ...node, type: w.type } as ReactNode);
  return expand(props["children"] as ReactNode);
}

export function find(out: readonly Out[], pred: (n: HostNode) => boolean): HostNode[] {
  const hits: HostNode[] = [];
  const walk = (list: readonly Out[]): void => {
    for (const n of list) {
      if (typeof n === "string" || typeof n === "number") continue;
      if (pred(n)) hits.push(n);
      walk(n.children);
    }
  };
  walk(out);
  return hits;
}

export function text(out: readonly Out[]): string {
  return out.map((n) => (typeof n === "string" || typeof n === "number" ? String(n) : text(n.children))).join("");
}
