import type { FetchLike } from "../port.js";

export const defaultFetch: FetchLike = (input, init) => fetch(input, init);

export class HttpError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Sends a request and parses JSON. Throws HttpError on non-2xx unless the status is in `allow`. */
export const requestJson = async (
  f: FetchLike,
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
  allow: readonly number[] = [],
): Promise<unknown> => {
  const res = await f(url, { method, headers, ...(body === undefined ? {} : { body }) });
  const text = await res.text();
  if (!res.ok && !allow.includes(res.status)) throw new HttpError(res.status, `${method} ${url} -> ${String(res.status)}: ${text.slice(0, 200)}`);
  if (text.length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
};

export const asRecord = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
export const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? v.toString() : "");
export const num = (v: unknown): number => (typeof v === "number" ? v : 0);
export const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);
