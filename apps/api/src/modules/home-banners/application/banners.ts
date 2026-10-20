import { composeSlides, lifecycleOf, transition, validateDraft, validateWindow, type BannerDraft, type HomeBanner, type Problem, type TransitionAction } from "../domain/banner";
import type { BannerAuditPort, BannerFlagPort, HomeBannerStore } from "../domain/ports";
import { FLAG_HOME_BANNERS } from "../domain/ports";

export interface Clock {
  nowMs(): number;
}
export interface BannerDeps {
  readonly store: HomeBannerStore;
  readonly audit: BannerAuditPort;
  readonly clock: Clock;
  readonly uuid: () => string;
  readonly flags: BannerFlagPort;
}

export interface Actor {
  readonly actorId: string;
  readonly requestId: string | null;
}

export type Outcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "invalid"; readonly problems: readonly Problem[] }
  | { readonly kind: "not_found" }
  | { readonly kind: "conflict"; readonly code: "invalid_state" | "version_conflict" | "window_elapsed" }
  | { readonly kind: "audit_unavailable" };

const ok = <T>(value: T): Outcome<T> => ({ kind: "ok", value });
const LIST_LIMIT = 200;
const CANDIDATE_LIMIT = 50;

/** Audit FIRST. If the append fails nothing is written. */
async function audited(d: BannerDeps, a: Actor, action: string, targetId: string, diff: Record<string, string | number | boolean | null>): Promise<boolean> {
  try {
    await d.audit.append({
      action: `home_banner.${action}`,
      actorId: a.actorId,
      targetType: "home_banner",
      targetId,
      reasonCode: null,
      diff,
      requestId: a.requestId,
      atMs: d.clock.nowMs(),
    });
    return true;
  } catch {
    return false;
  }
}

const fieldNames = (d: Partial<Record<keyof BannerDraft, unknown>>): string =>
  Object.keys(d).sort().join(",");

export class CreateBanner {
  constructor(private readonly d: BannerDeps) {}
  async execute(a: Actor, draft: BannerDraft): Promise<Outcome<HomeBanner>> {
    const problems = validateDraft(draft);
    if (problems.length > 0) return { kind: "invalid", problems };
    const now = this.d.clock.nowMs();
    const b: HomeBanner = { ...draft, id: this.d.uuid(), status: "draft", createdBy: a.actorId, updatedBy: a.actorId, version: 1, createdAtMs: now, updatedAtMs: now };
    if (!(await audited(this.d, a, "create", b.id, { sponsored: b.sponsored, cta_kind: b.cta.kind }))) return { kind: "audit_unavailable" };
    await this.d.store.insert(b);
    return ok(b);
  }
}

export type BannerPatch = Partial<BannerDraft>;

export class UpdateBanner {
  constructor(private readonly d: BannerDeps) {}
  async execute(a: Actor, id: string, patch: BannerPatch, expectedVersion?: number): Promise<Outcome<HomeBanner>> {
    const cur = await this.d.store.get(id);
    if (cur === null) return { kind: "not_found" };
    if (expectedVersion !== undefined && expectedVersion !== cur.version) return { kind: "conflict", code: "version_conflict" };
    const next: HomeBanner = { ...cur, ...patch, updatedBy: a.actorId, updatedAtMs: this.d.clock.nowMs() };
    const problems = validateDraft(next);
    if (problems.length > 0) return { kind: "invalid", problems };
    if (!(await audited(this.d, a, "update", id, { fields: fieldNames(patch), sponsored: next.sponsored }))) return { kind: "audit_unavailable" };
    const saved = await this.d.store.replace(next, cur.version);
    return saved === null ? { kind: "conflict", code: "version_conflict" } : ok(saved);
  }
}

export class ChangeBannerStatus {
  constructor(private readonly d: BannerDeps) {}
  async execute(a: Actor, id: string, action: TransitionAction): Promise<Outcome<HomeBanner>> {
    const cur = await this.d.store.get(id);
    if (cur === null) return { kind: "not_found" };
    const t = transition(cur, action, this.d.clock.nowMs());
    if (t.kind === "invalid_state") return { kind: "conflict", code: "invalid_state" };
    if (t.kind === "window_elapsed") return { kind: "conflict", code: "window_elapsed" };
    if (action === "schedule") {
      const w = validateWindow(cur.startsAtMs, cur.endsAtMs);
      if (w.length > 0) return { kind: "invalid", problems: w };
    }
    if (!(await audited(this.d, a, action, id, { from: cur.status, to: t.status, sponsored: cur.sponsored }))) return { kind: "audit_unavailable" };
    const saved = await this.d.store.replace({ ...cur, status: t.status, updatedBy: a.actorId, updatedAtMs: this.d.clock.nowMs() }, cur.version);
    return saved === null ? { kind: "conflict", code: "version_conflict" } : ok(saved);
  }
}

export class DeleteBanner {
  constructor(private readonly d: BannerDeps) {}
  async execute(a: Actor, id: string): Promise<Outcome<true>> {
    const cur = await this.d.store.get(id);
    if (cur === null) return { kind: "not_found" };
    if (!(await audited(this.d, a, "delete", id, { status: cur.status, sponsored: cur.sponsored }))) return { kind: "audit_unavailable" };
    await this.d.store.remove(id);
    return ok(true);
  }
}

export interface AdminBannerView {
  readonly banner: HomeBanner;
  readonly lifecycle: ReturnType<typeof lifecycleOf>;
}

export class ListBannersAdmin {
  constructor(private readonly d: BannerDeps) {}
  async execute(): Promise<readonly AdminBannerView[]> {
    const now = this.d.clock.nowMs();
    return (await this.d.store.list(LIST_LIMIT)).map((banner) => ({ banner, lifecycle: lifecycleOf(banner, now) }));
  }
}

export class GetBannerAdmin {
  constructor(private readonly d: BannerDeps) {}
  async execute(id: string): Promise<AdminBannerView | null> {
    const b = await this.d.store.get(id);
    return b === null ? null : { banner: b, lifecycle: lifecycleOf(b, this.d.clock.nowMs()) };
  }
}

export interface ActiveBanners {
  readonly items: readonly HomeBanner[];
  readonly serverTimeMs: number;
}

/** Shopper read: the SERVER clock decides what is live. Kill switch off: an empty carousel, never an error. */
export class ListActiveBanners {
  constructor(private readonly d: BannerDeps) {}
  async execute(): Promise<ActiveBanners> {
    const now = this.d.clock.nowMs();
    const on = await Promise.resolve(this.d.flags.isEnabled(FLAG_HOME_BANNERS)).catch(() => false);
    if (!on) return { items: [], serverTimeMs: now };
    return { items: composeSlides(await this.d.store.listScheduledAt(now, CANDIDATE_LIMIT), now), serverTimeMs: now };
  }
}

/** Admin preview: what the carousel would show at `atMs`, ignoring the kill switch (labelled by the route). */
export class PreviewBanners {
  constructor(private readonly d: BannerDeps) {}
  async execute(atMs: number): Promise<readonly HomeBanner[]> {
    return composeSlides(await this.d.store.listScheduledAt(atMs, CANDIDATE_LIMIT), atMs);
  }
}
