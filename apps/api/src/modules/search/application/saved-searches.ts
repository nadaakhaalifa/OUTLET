import type { Clock, IdGenerator } from "../../../platform/ports";
import { MAX_FACETS, countFacets, type SearchFilter } from "../domain/bridge";
import {
  MAX_SAVED_SEARCHES,
  type SavedSearchCursor,
  type SavedSearchPatch,
  type SavedSearchRecord,
  type SavedSearchRepository,
  type SearchEventPublisher,
} from "../domain/ports";

export interface SavedSearchDeps {
  readonly repo: SavedSearchRepository;
  readonly events: SearchEventPublisher;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export type CreateResult =
  | { readonly kind: "ok"; readonly record: SavedSearchRecord }
  | { readonly kind: "limit_reached" }
  | { readonly kind: "too_many_facets" };

export class CreateSavedSearch {
  constructor(private readonly d: SavedSearchDeps) {}

  async execute(input: {
    readonly userId: string;
    readonly name: string;
    readonly query: string | null;
    readonly filter: SearchFilter;
    readonly alertEnabled: boolean;
  }): Promise<CreateResult> {
    if (countFacets(input.filter) > MAX_FACETS) return { kind: "too_many_facets" };
    if ((await this.d.repo.count(input.userId)) >= MAX_SAVED_SEARCHES) return { kind: "limit_reached" };
    const now = this.d.clock.nowMs();
    const record: SavedSearchRecord = {
      id: this.d.ids.uuidV7(),
      userId: input.userId,
      name: input.name.trim(),
      query: input.query,
      filter: input.filter,
      alertEnabled: input.alertEnabled,
      lastRunAtMs: null,
      createdAtMs: now,
      updatedAtMs: now,
    };
    await this.d.repo.create(record);
    await this.d.events.publish({ name: "saved_search.created", userId: input.userId, id: record.id });
    return { kind: "ok", record };
  }
}

export class ListSavedSearches {
  constructor(private readonly d: SavedSearchDeps) {}

  async execute(input: { readonly userId: string; readonly limit: number; readonly after: SavedSearchCursor | null }) {
    const rows = await this.d.repo.list(input.userId, input.limit + 1, input.after);
    const page = rows.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      items: page,
      hasMore: rows.length > input.limit,
      next: rows.length > input.limit && last !== undefined ? { createdAtMs: last.createdAtMs, id: last.id } : null,
    };
  }
}

export class GetSavedSearch {
  constructor(private readonly d: SavedSearchDeps) {}
  execute(input: { readonly userId: string; readonly id: string }) {
    return this.d.repo.get(input.userId, input.id);
  }
}

export class UpdateSavedSearch {
  constructor(private readonly d: SavedSearchDeps) {}
  async execute(input: { readonly userId: string; readonly id: string; readonly patch: SavedSearchPatch }) {
    if (input.patch.filter !== undefined && countFacets(input.patch.filter) > MAX_FACETS) {
      return { kind: "too_many_facets" as const };
    }
    const r = await this.d.repo.update(input.userId, input.id, input.patch, this.d.clock.nowMs());
    return r === null ? { kind: "not_found" as const } : { kind: "ok" as const, record: r };
  }
}

export class DeleteSavedSearch {
  constructor(private readonly d: SavedSearchDeps) {}
  async execute(input: { readonly userId: string; readonly id: string }): Promise<boolean> {
    const ok = await this.d.repo.delete(input.userId, input.id);
    if (ok) await this.d.events.publish({ name: "saved_search.deleted", userId: input.userId, id: input.id });
    return ok;
  }
}
