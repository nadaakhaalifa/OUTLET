"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Page } from "../../lib/client-api";
import { isProblem } from "./shared";

export interface PagedState<T> {
  readonly items: readonly T[];
  readonly state: "loading" | "out" | "error" | "ready";
  readonly more: boolean;
  readonly loadingMore: boolean;
  readonly moreError: boolean;
  readonly loadMore: () => void;
}

/** Keyset pagination: the first page on mount, then explicit "load more" with the server's cursor. */
export function usePaged<T>(fetchPage: (cursor?: string) => Promise<Page<T>>): PagedState<T> {
  const [items, setItems] = useState<readonly T[]>([]);
  const [state, setState] = useState<PagedState<T>["state"]>("loading");
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  useEffect(() => {
    let live = true;
    fetchRef.current().then((p) => { if (live) { setItems(p.items); setCursor(p.nextCursor); setState("ready"); } }, (e: unknown) => { if (live) setState(isProblem(e, 401) ? "out" : "error"); });
    return () => { live = false; };
  }, []);

  const loadMore = useCallback(() => {
    if (cursor === null) return;
    setLoadingMore(true); setMoreError(false);
    fetchRef.current(cursor).then((p) => { setItems((prev) => [...prev, ...p.items]); setCursor(p.nextCursor); }, () => { setMoreError(true); }).finally(() => { setLoadingMore(false); });
  }, [cursor]);

  return { items, state, more: cursor !== null, loadingMore, moreError, loadMore };
}
