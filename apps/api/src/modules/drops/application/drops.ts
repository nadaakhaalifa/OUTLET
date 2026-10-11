import {
  checkEdit,
  dropMachine,
  nextState,
  socialProof,
  validateDraft,
  needsRefresh,
  type Drop,
  type DropDraft,
  type DropItem,
  type DropState,
  type EditPatch,
  type FieldError,
  type SocialProof,
} from "../domain/bridge";
import type { DropOutboxEvent } from "../domain/ports";
import { page, withState, type DropDeps, type Page } from "./shared";

const evt = (d: Drop, to: DropState): DropOutboxEvent | null => {
  switch (to) {
    case "SCHEDULED":
      return { type: "drop.scheduled", dropId: d.id, storeId: d.storeId, startsAtMs: d.startsAtMs };
    case "EARLY_ACCESS":
      return { type: "drop.early_access_opened", dropId: d.id, storeId: d.storeId };
    case "LIVE":
      return { type: "drop.live", dropId: d.id, storeId: d.storeId };
    case "SOLD_OUT":
      return { type: "drop.sold_out", dropId: d.id, storeId: d.storeId };
    default:
      return null;
  }
};
export const lifecycleEvents = (d: Drop, to: DropState): readonly DropOutboxEvent[] => {
  const e = evt(d, to);
  return e === null ? [] : [e];
};

export type CreateOutcome =
  | { readonly kind: "created"; readonly drop: Drop }
  | { readonly kind: "invalid"; readonly errors: readonly FieldError[] }
  | { readonly kind: "type_disabled" };

export class CreateDrop {
  constructor(private readonly d: DropDeps) {}
  async execute(i: { storeId: string; draft: Omit<DropDraft, "admitPerSec"> & { admitPerSec: number | null } }): Promise<CreateOutcome> {
    const { clock, ids, store, switches, cfg } = this.d;
    const draft: DropDraft = { ...i.draft, admitPerSec: i.draft.admitPerSec ?? cfg.defaultAdmitPerSec };
    const errors = validateDraft(draft);
    if (errors.length > 0) return { kind: "invalid", errors };
    if (!(await switches.allowed(`drop_type_${draft.type}`))) return { kind: "type_disabled" };
    const now = clock.nowMs();
    const drop: Drop = {
      ...draft,
      id: ids.uuidV7(),
      storeId: i.storeId,
      state: "DRAFT",
      paused: false,
      createdAtMs: now,
      updatedAtMs: now,
      version: 1,
    };
    await store.insert(drop, []);
    return { kind: "created", drop };
  }
}

export type EditOutcome =
  | { readonly kind: "ok"; readonly drop: Drop }
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid"; readonly errors: readonly FieldError[] }
  | { readonly kind: "locked"; readonly code: string }
  | { readonly kind: "conflict" };

export interface EditInput {
  readonly dropId: string;
  readonly title?: string;
  readonly startsAtMs?: number;
  readonly endsAtMs?: number;
  readonly earlyAccessAtMs?: number | null;
  readonly items?: readonly DropItem[];
  readonly limits?: Drop["limits"];
  readonly admitPerSec?: number;
}

export class EditDrop {
  constructor(private readonly d: DropDeps) {}
  async execute(i: EditInput): Promise<EditOutcome> {
    const { store, clock, inventory } = this.d;
    const cur = await store.get(i.dropId);
    if (cur === null) return { kind: "not_found" };
    const patch: EditPatch = {
      ...(i.title !== undefined ? { title: i.title } : {}),
      ...(i.startsAtMs !== undefined ? { startsAtMs: i.startsAtMs } : {}),
      ...(i.endsAtMs !== undefined ? { endsAtMs: i.endsAtMs } : {}),
      ...(i.items !== undefined ? { items: i.items } : {}),
      ...(i.limits !== undefined ? { limits: i.limits } : {}),
    };
    const verdict = checkEdit(cur, patch);
    if (!verdict.ok) return { kind: "locked", code: verdict.code };
    if (cur.state === "SCHEDULED" && (i.earlyAccessAtMs !== undefined && i.earlyAccessAtMs !== cur.earlyAccessAtMs)) {
      return { kind: "locked", code: "schedule_locked" };
    }
    const next: Drop = {
      ...cur,
      title: i.title ?? cur.title,
      startsAtMs: i.startsAtMs ?? cur.startsAtMs,
      endsAtMs: i.endsAtMs ?? cur.endsAtMs,
      earlyAccessAtMs: i.earlyAccessAtMs === undefined ? cur.earlyAccessAtMs : i.earlyAccessAtMs,
      items: i.items ?? cur.items,
      limits: i.limits ?? cur.limits,
      admitPerSec: i.admitPerSec ?? cur.admitPerSec,
      updatedAtMs: clock.nowMs(),
    };
    const errors = validateDraft(next);
    if (errors.length > 0) return { kind: "invalid", errors };
    const r = await store.save(next, cur.version, []);
    if (r === "not_found") return { kind: "not_found" };
    if (r === "conflict") return { kind: "conflict" };
    if (cur.state === "SCHEDULED") for (const it of next.items) await inventory.setCap(next.id, it.skuId, it.stockCap);
    return { kind: "ok", drop: { ...next, version: cur.version + 1 } };
  }
}

export type TransitionOutcome =
  | { readonly kind: "ok"; readonly drop: Drop }
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid_transition" }
  | { readonly kind: "too_late" }
  | { readonly kind: "conflict" };

export class ScheduleDrop {
  constructor(private readonly d: DropDeps) {}
  async execute(dropId: string): Promise<TransitionOutcome> {
    const { store, clock, inventory } = this.d;
    const cur = await store.get(dropId);
    if (cur === null) return { kind: "not_found" };
    if (!dropMachine.can(cur.state, "SCHEDULE")) return { kind: "invalid_transition" };
    const now = clock.nowMs();
    // A drop that would already be open cannot be scheduled: the ladder and the waiting room are server timed.
    if ((cur.earlyAccessAtMs ?? cur.startsAtMs) <= now) return { kind: "too_late" };
    const errors = validateDraft(cur);
    if (errors.length > 0) return { kind: "invalid_transition" };
    const to = nextState(cur.state, "SCHEDULE");
    const next = withState(cur, to, now);
    const r = await store.save(next, cur.version, lifecycleEvents(next, to));
    if (r === "not_found") return { kind: "not_found" };
    if (r === "conflict") return { kind: "conflict" };
    for (const it of cur.items) await inventory.setCap(cur.id, it.skuId, it.stockCap);
    return { kind: "ok", drop: { ...next, version: cur.version + 1 } };
  }
}

export class RemoveDrop {
  constructor(private readonly d: DropDeps) {}
  /** DRAFT is deleted; SCHEDULED is cancelled (archived). Anything running is T&S's call (admin). */
  async execute(dropId: string): Promise<TransitionOutcome> {
    const { store, clock } = this.d;
    const cur = await store.get(dropId);
    if (cur === null) return { kind: "not_found" };
    if (cur.state === "DRAFT") {
      return (await store.removeDraft(dropId)) ? { kind: "ok", drop: cur } : { kind: "conflict" };
    }
    if (!dropMachine.can(cur.state, "CANCEL")) return { kind: "invalid_transition" };
    const next = withState(cur, nextState(cur.state, "CANCEL"), clock.nowMs());
    const r = await store.save(next, cur.version, [{ type: "drop.cancelled", dropId: cur.id, storeId: cur.storeId }]);
    if (r === "not_found") return { kind: "not_found" };
    if (r === "conflict") return { kind: "conflict" };
    await this.d.inventory.closeDrop(cur.id);
    return { kind: "ok", drop: { ...next, version: cur.version + 1 } };
  }
}

export class GetDrop {
  constructor(private readonly d: DropDeps) {}
  /** Seller view: the caller already passed the tenant check. Public view hides DRAFT. */
  async execute(dropId: string, opts: { readonly publicOnly: boolean }): Promise<Drop | null> {
    const cur = await this.d.store.get(dropId);
    if (cur === null) return null;
    if (opts.publicOnly && (cur.state === "DRAFT" || cur.state === "ARCHIVED")) return null;
    return cur;
  }
}

export class ListPublicDrops {
  constructor(private readonly d: DropDeps) {}
  execute(cursor: string | null, limit: number): Promise<Page<Drop>> {
    return page(cursor, limit, (after, n) => this.d.store.listPublic(after, n));
  }
}

export class ListSellerDrops {
  constructor(private readonly d: DropDeps) {}
  execute(storeIds: readonly string[], cursor: string | null, limit: number): Promise<Page<Drop>> {
    return page(cursor, limit, (after, n) => this.d.store.listByStores(storeIds, after, n));
  }
}

export interface PublicDropView {
  readonly drop: Drop;
  readonly social: SocialProof;
  readonly waitlistSize: number;
  /** Real remaining units across SKUs when it is <= 5 (also covered by `social.remaining`). */
}

/** Shopper facing detail with truthful social proof, recomputed at most once per minute per drop. */
export class GetPublicDropView {
  private readonly cache = new Map<string, { at: number; value: SocialProof }>();
  constructor(private readonly d: DropDeps) {}

  async execute(dropId: string): Promise<PublicDropView | null> {
    const { store, clock, cfg } = this.d;
    const drop = await store.get(dropId);
    if (drop === null || drop.state === "DRAFT" || drop.state === "ARCHIVED") return null;
    const now = clock.nowMs();
    const hit = this.cache.get(dropId);
    let value = hit?.value;
    if (hit === undefined || needsRefresh(hit.at, now, cfg.socialProof)) {
      value = await this.compute(drop, now);
      this.cache.set(dropId, { at: now, value });
    }
    return { drop, social: value ?? { boughtToday: null, viewingNow: null, remaining: null }, waitlistSize: await store.waitlistSize(dropId) };
  }

  private async compute(drop: Drop, now: number): Promise<SocialProof> {
    const { store, inventory, signals, cfg } = this.d;
    // Each signal is optional: an unavailable one shows nothing, never a guess.
    const orNull = async <T>(f: () => Promise<T>): Promise<T | null> => {
      try {
        return await f();
      } catch {
        return null;
      }
    };
    const boughtToday = await orNull(() => store.boughtSince(drop.id, now - 24 * 3_600_000));
    const left = await orNull(async () => {
      let n = 0;
      for (const it of drop.items) n += (await inventory.snapshot(drop.id, it.skuId)).available;
      return n;
    });
    const viewing = await orNull(() => signals.viewingNow(drop.id));
    // Remaining is meaningful only while the drop can sell.
    const sells = drop.state === "LIVE" || drop.state === "EARLY_ACCESS";
    return socialProof({ boughtToday, viewingNow: viewing, remaining: sells ? left : null }, cfg.socialProof);
  }
}

export type AdminAction = "pause" | "resume" | "end";
export type AdminOutcome =
  | { readonly kind: "ok"; readonly drop: Drop }
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid_transition" }
  | { readonly kind: "conflict" };

export class AdminControlDrop {
  constructor(private readonly d: DropDeps) {}
  async execute(dropId: string, action: AdminAction): Promise<AdminOutcome> {
    const { store, clock, inventory } = this.d;
    const cur = await store.get(dropId);
    if (cur === null) return { kind: "not_found" };
    const now = clock.nowMs();
    if (action === "end") {
      if (!dropMachine.can(cur.state, "WINDOW_CLOSED")) return { kind: "invalid_transition" };
      const next = { ...withState(cur, nextState(cur.state, "WINDOW_CLOSED"), now), paused: false };
      const r = await store.save(next, cur.version, [{ type: "drop.ended", dropId: cur.id, storeId: cur.storeId, reason: "admin" }]);
      if (r === "not_found") return { kind: "not_found" };
      if (r === "conflict") return { kind: "conflict" };
      // Orders already placed are honoured; the unsold pool goes back to the seller.
      await inventory.closeDrop(cur.id);
      return { kind: "ok", drop: { ...next, version: cur.version + 1 } };
    }
    const paused = action === "pause";
    if (cur.paused === paused) return { kind: "ok", drop: cur };
    if (cur.state === "DRAFT" || cur.state === "ARCHIVED" || cur.state === "ENDED" || cur.state === "SOLD_OUT") return { kind: "invalid_transition" };
    const next: Drop = { ...cur, paused, updatedAtMs: now };
    const r = await store.save(next, cur.version, [{ type: "drop.paused", dropId: cur.id, storeId: cur.storeId, paused }]);
    if (r === "not_found") return { kind: "not_found" };
    if (r === "conflict") return { kind: "conflict" };
    return { kind: "ok", drop: { ...next, version: cur.version + 1 } };
  }
}

export type WaitlistOutcome = { readonly kind: "joined" | "already" } | { readonly kind: "not_found" } | { readonly kind: "not_sold_out" } | { readonly kind: "closed" };

export class JoinWaitlist {
  constructor(private readonly d: DropDeps) {}
  async execute(i: { dropId: string; userId: string }): Promise<WaitlistOutcome> {
    const { store, flags, clock } = this.d;
    const drop = await store.get(i.dropId);
    if (drop === null || drop.state === "DRAFT" || drop.state === "ARCHIVED") return { kind: "not_found" };
    if (drop.state === "ENDED") return { kind: "closed" };
    const open = drop.state === "SOLD_OUT" || ((drop.state === "LIVE" || drop.state === "EARLY_ACCESS") && (await flags.isSoldOut(drop.id)));
    if (!open) return { kind: "not_sold_out" };
    const r = await store.addWaitlist(drop.id, i.userId, clock.nowMs(), [{ type: "drop.waitlist_joined", dropId: drop.id, userId: i.userId }]);
    return { kind: r === "added" ? "joined" : "already" };
  }
}
