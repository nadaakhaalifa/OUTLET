import type { z } from "zod";
import { adminGet } from "../server/admin-get";

export type Loaded<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly status: number; readonly code: string };

/** Fetch + Zod-validate. A contract mismatch is reported as an error, never papered over. */
export async function load<S extends z.ZodType>(schema: S, market: string, path: string, query: Readonly<Record<string, string | undefined>> = {}): Promise<Loaded<z.infer<S>>> {
  const r = await adminGet(market, path, query);
  if (!r.ok) return r;
  const parsed = schema.safeParse(r.data);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, status: 502, code: "bad-response" };
}
