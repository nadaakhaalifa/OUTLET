import type { CrawlStore, IncidentKind, IncidentRow, ParityWarning, ParityWarningsPort } from "../domain/ports";

/** Opaque keyset cursor: `<createdAtMs>.<id>` in base64url. Validated by the controller's Zod schema. */
export const encodeCursor = (atMs: number, id: string): string => Buffer.from(`${atMs}.${id}`, "utf8").toString("base64url");

export function decodeCursor(raw: string): { atMs: number; id: string } | null {
  const m = /^(\d{1,15})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(Buffer.from(raw, "base64url").toString("utf8"));
  return m === null ? null : { atMs: Number(m[1]), id: m[2] ?? "" };
}

export interface IncidentPage {
  readonly items: readonly IncidentRow[];
  readonly nextCursor: string | null;
}

/** Lists incidents newest first. `storeId` null is the platform-wide admin view. */
export class ListCrawlIncidents {
  constructor(private readonly store: CrawlStore) {}
  async execute(i: { storeId: string | null; kind: IncidentKind | null; limit: number; after: { atMs: number; id: string } | null }): Promise<IncidentPage> {
    const rows = await this.store.listIncidents({ storeId: i.storeId, kind: i.kind, limit: i.limit + 1, after: i.after });
    const items = rows.slice(0, i.limit);
    const last = items[items.length - 1];
    return { items, nextCursor: rows.length > i.limit && last !== undefined ? encodeCursor(last.createdAtMs, last.id) : null };
  }
}

/** Cross-channel parity: 48 hours to fix, then price-integrity auto-pauses the SKU (spec 9.3). */
export const PARITY_FIX_WINDOW_MS = 48 * 3_600_000;

export interface ParityWarningView extends ParityWarning {
  readonly deadlineMs: number;
  readonly remainingMs: number;
  readonly overdue: boolean;
}

export class ListParityWarnings {
  constructor(
    private readonly parity: ParityWarningsPort,
    private readonly nowMs: () => number,
  ) {}
  async execute(storeId: string, limit: number, afterSku: string | null): Promise<{ items: readonly ParityWarningView[]; nextCursor: string | null }> {
    const now = this.nowMs();
    const all = [...(await this.parity.openFor(storeId))].sort((a, b) => (a.skuId < b.skuId ? -1 : a.skuId > b.skuId ? 1 : 0));
    const rest = afterSku === null ? all : all.filter((w) => w.skuId > afterSku);
    const page = rest.slice(0, limit);
    const view = page.map((w) => {
      const deadlineMs = w.openedAtMs + PARITY_FIX_WINDOW_MS;
      return { ...w, deadlineMs, remainingMs: Math.max(0, deadlineMs - now), overdue: now >= deadlineMs };
    });
    const last = page[page.length - 1];
    return { items: view, nextCursor: rest.length > limit && last !== undefined ? Buffer.from(last.skuId, "utf8").toString("base64url") : null };
  }
}

/**
 * Structural view of price-integrity's open cross-channel findings (its `EnforcementStore.openCrossChannel`),
 * so this module imports nothing from it. Keyset-paged by sku id: no fixed record cap.
 */
export interface TrustReader {
  openCrossChannel(
    storeId: string,
    afterSkuId: string | null,
    limit: number,
  ): Promise<readonly { readonly skuId: string | null; readonly openedAtMs: number }[]>;
}

const PARITY_PAGE = 100;

export class PriceIntegrityParityAdapter implements ParityWarningsPort {
  constructor(private readonly trust: TrustReader) {}
  async openFor(storeId: string): Promise<readonly ParityWarning[]> {
    const out: ParityWarning[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await this.trust.openCrossChannel(storeId, after, PARITY_PAGE);
      for (const r of page) if (r.skuId !== null) out.push({ skuId: r.skuId, openedAtMs: r.openedAtMs });
      const last = page[page.length - 1];
      if (page.length < PARITY_PAGE || last === undefined || last.skuId === null) return out;
      after = last.skuId;
    }
  }
}
