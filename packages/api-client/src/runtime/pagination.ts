import type { ApiResponse } from "./types";

export interface PageLike<T> {
  readonly items: readonly T[];
  readonly page: { readonly next_cursor: string | null; readonly has_more: boolean };
}

/** Follows `page.next_cursor` until the server says there is no more. `maxPages` bounds a runaway server. */
export async function* paginate<T>(
  fetchPage: (cursor: string | undefined) => Promise<ApiResponse<PageLike<T>>>,
  maxPages = 100,
): AsyncGenerator<T, void, undefined> {
  let cursor: string | undefined;
  for (let n = 0; n < maxPages; n++) {
    const res = await fetchPage(cursor);
    if (res.notModified) return;
    for (const item of res.data.items) yield item;
    if (!res.data.page.has_more || res.data.page.next_cursor === null) return;
    cursor = res.data.page.next_cursor;
  }
}

export async function collectPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<ApiResponse<PageLike<T>>>,
  maxPages = 100,
): Promise<T[]> {
  const out: T[] = [];
  for await (const item of paginate(fetchPage, maxPages)) out.push(item);
  return out;
}
