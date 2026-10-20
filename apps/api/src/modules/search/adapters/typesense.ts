import {
  SearchUnavailableError,
  type SearchPage,
  type SearchPort,
  type SearchRequest,
} from "../domain/ports";

/** The network seam. A real client (HTTP to the Typesense cluster) implements this in a later wave. */
export interface TypesenseTransport {
  search(req: SearchRequest): Promise<SearchPage>;
  suggest(prefixNormalized: string, limit: number): Promise<readonly string[]>;
}

export const TYPESENSE_TIMEOUT_MS = 300;

/**
 * Typesense adapter STUB behind the SearchPort contract. Without a transport it reports itself
 * unavailable, which makes the use case serve the Postgres FTS fallback (degraded: true). Any
 * transport failure or timeout maps to SearchUnavailableError so callers have one failure type.
 * Contract it must honour once real: same filter semantics as `docMatches`, in-stock only.
 */
export class TypesenseSearchPort implements SearchPort {
  readonly engine = "typesense" as const;

  constructor(
    private readonly transport: TypesenseTransport | null = null,
    private readonly timeoutMs: number = TYPESENSE_TIMEOUT_MS,
  ) {}

  private async guarded<T>(run: (t: TypesenseTransport) => Promise<T>): Promise<T> {
    if (this.transport === null) throw new SearchUnavailableError("typesense");
    const t = this.transport;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        run(t),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SearchUnavailableError("typesense")), this.timeoutMs);
        }),
      ]);
    } catch (e) {
      if (e instanceof SearchUnavailableError) throw e;
      throw new SearchUnavailableError("typesense");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  search(req: SearchRequest): Promise<SearchPage> {
    return this.guarded((t) => t.search(req));
  }

  suggest(prefixNormalized: string, limit: number): Promise<readonly string[]> {
    return this.guarded((t) => t.suggest(prefixNormalized, limit));
  }
}
