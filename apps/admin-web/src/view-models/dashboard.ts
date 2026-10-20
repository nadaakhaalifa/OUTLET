import type { MessageKey } from "../i18n";
import { countLabel } from "./brand-review";
import type { Role } from "./common";
import { navAllowsPath } from "./nav";

export type TileId =
  | "brandUnassigned" | "brandMine" | "brandLate" | "approvals" | "suspensions" | "moderation" | "dsarOpen" | "dsarOverdue" | "recon"
  | "killSwitches" | "kyc" | "taxRejected" | "refundApprovals" | "payoutsStuck";
export type TileSectionId = "approvals" | "queues" | "money" | "privacy" | "platform";
/** breach = a deadline or integrity line was crossed; action = someone has to act; info = context only. */
export type Severity = "breach" | "action" | "info";

export interface TileSpec {
  readonly id: TileId;
  readonly section: TileSectionId;
  readonly labelKey: MessageKey;
  readonly noteKey: MessageKey;
  readonly href: string;
  /** The nav area whose role gate decides visibility: a role that cannot open the area never sees (or queries) the tile. */
  readonly gate: string;
  readonly severity: Severity;
  /** The visible word shown next to a breach tile with count > 0 (never colour alone). */
  readonly breachLabelKey?: MessageKey;
}

export const TILE_SECTIONS: readonly { readonly id: TileSectionId; readonly titleKey: MessageKey }[] = [
  { id: "approvals", titleKey: "home.section.approvals" },
  { id: "queues", titleKey: "home.section.queues" },
  { id: "money", titleKey: "home.section.money" },
  { id: "privacy", titleKey: "home.section.privacy" },
  { id: "platform", titleKey: "home.section.platform" },
];

const TILES: readonly TileSpec[] = [
  { id: "approvals", section: "approvals", labelKey: "home.tile.approvals", noteKey: "home.note.approvals", href: "/approvals", gate: "/approvals", severity: "action" },
  { id: "refundApprovals", section: "approvals", labelKey: "home.tile.refundApprovals", noteKey: "home.note.refundApprovals", href: "/approvals", gate: "/approvals", severity: "info" },
  { id: "brandUnassigned", section: "queues", labelKey: "brand.tile.unassigned", noteKey: "home.note.brandUnassigned", href: "/brand-applications?status=IN_REVIEW&assignee=unassigned", gate: "/brand-applications", severity: "action" },
  { id: "brandMine", section: "queues", labelKey: "brand.tile.mine", noteKey: "home.note.brandMine", href: "/brand-applications/mine", gate: "/brand-applications", severity: "info" },
  { id: "brandLate", section: "queues", labelKey: "brand.tile.late", noteKey: "home.note.brandLate", href: "/brand-applications?sla_breached=true", gate: "/brand-applications", severity: "breach", breachLabelKey: "home.badge.pastSla" },
  { id: "suspensions", section: "queues", labelKey: "home.tile.suspensions", noteKey: "home.note.suspensions", href: "/suspensions", gate: "/suspensions", severity: "breach", breachLabelKey: "home.badge.overdue" },
  { id: "kyc", section: "queues", labelKey: "home.tile.kyc", noteKey: "home.note.kyc", href: "/sellers", gate: "/sellers", severity: "action" },
  { id: "moderation", section: "queues", labelKey: "home.tile.moderation", noteKey: "home.note.moderation", href: "/moderation", gate: "/moderation", severity: "action" },
  { id: "recon", section: "money", labelKey: "home.tile.recon", noteKey: "home.note.recon", href: "/finance", gate: "/finance", severity: "breach", breachLabelKey: "home.badge.unresolved" },
  { id: "payoutsStuck", section: "money", labelKey: "home.tile.payoutsStuck", noteKey: "home.note.payoutsStuck", href: "/finance", gate: "/finance", severity: "breach", breachLabelKey: "home.badge.held" },
  { id: "taxRejected", section: "money", labelKey: "home.tile.taxRejected", noteKey: "home.note.taxRejected", href: "/tax", gate: "/tax", severity: "action" },
  { id: "dsarOpen", section: "privacy", labelKey: "home.tile.dsarOpen", noteKey: "home.note.dsarOpen", href: "/privacy", gate: "/privacy", severity: "info" },
  { id: "dsarOverdue", section: "privacy", labelKey: "home.tile.dsarOverdue", noteKey: "home.note.dsarOverdue", href: "/privacy", gate: "/privacy", severity: "breach", breachLabelKey: "home.badge.overdue" },
  { id: "killSwitches", section: "platform", labelKey: "home.tile.killSwitches", noteKey: "home.note.killSwitches", href: "/flags", gate: "/flags", severity: "info" },
];

export const tileSpec = (id: TileId): TileSpec | undefined => TILES.find((t) => t.id === id);

/** Tiles this role set may see, in display order. Fail closed: unknown roles (null) see none, and nothing is queried for them. */
export function tilesFor(roles: readonly Role[] | null): readonly TileSpec[] {
  return TILES.filter((t) => navAllowsPath(roles, t.gate));
}

export interface TileSectionView {
  readonly id: TileSectionId;
  readonly titleKey: MessageKey;
  readonly tiles: readonly TileSpec[];
}

/** Which section a role wants first. Roles not listed fall back to the default order. */
export const ROLE_HOME_ORDER: Readonly<Record<Role, readonly TileSectionId[]>> = {
  finance: ["money", "approvals", "queues", "platform", "privacy"],
  dpo: ["privacy", "approvals", "queues", "money", "platform"],
  trust_safety: ["queues", "approvals", "privacy", "money", "platform"],
  ops: ["queues", "approvals", "money", "platform", "privacy"],
  support: ["approvals", "queues", "money", "privacy", "platform"],
  marketing: ["approvals", "queues", "money", "privacy", "platform"],
  security: ["platform", "queues", "approvals", "privacy", "money"],
  super_admin: ["approvals", "queues", "money", "privacy", "platform"],
};

/**
 * Sections for the home page. Order: the sections that contain a breach-severity tile first, then by the best
 * rank any of the caller's roles gives the section (so multiple roles merge), then the default order.
 * Static (no counts needed) so every section can stream on its own.
 */
export function tileSectionsFor(roles: readonly Role[] | null): readonly TileSectionView[] {
  const tiles = tilesFor(roles);
  const rank = (id: TileSectionId): number => {
    const ranks = (roles ?? []).map((r) => ROLE_HOME_ORDER[r]?.indexOf(id) ?? -1).filter((n) => n >= 0);
    return ranks.length === 0 ? 99 : Math.min(...ranks);
  };
  const views = TILE_SECTIONS.map((s) => ({ ...s, tiles: tiles.filter((t) => t.section === s.id) })).filter((s) => s.tiles.length > 0);
  const breachy = (s: TileSectionView): number => (s.tiles.some((t) => t.severity === "breach") ? 0 : 1);
  return [...views].sort((a, b) => breachy(a) - breachy(b) || rank(a.id) - rank(b.id));
}

export interface TileValue {
  /** ASCII digits, "50+" when the read was capped, or the em dash when the read failed. Never a guessed number. */
  readonly text: string;
  readonly failed: boolean;
  readonly capped: boolean;
  /** The counted number, or null when unknown (failed or not available yet). */
  readonly count: number | null;
  /** The endpoint is dark (404 behind a release flag): "not available yet", which is not zero and not a failure. */
  readonly notYet: boolean;
}

export const FAILED_TILE: TileValue = { text: "—", failed: true, capped: false, count: null, notYet: false };
export const NOT_YET_TILE: TileValue = { text: "—", failed: false, capped: false, count: null, notYet: true };

export function tileValue(count: number, hasMore: boolean): TileValue {
  return { text: countLabel(count, hasMore), failed: false, capped: hasMore, count, notYet: false };
}

/** Lists with no page object: a full page (length >= limit) means there may be more, so show "limit+". */
export function cappedByLimit(length: number, limit: number): TileValue {
  return tileValue(length, length >= limit);
}

export type TileState = "failed" | "notYet" | "zero" | "capped" | "count";

export function tileState(v: TileValue): TileState {
  if (v.failed) return "failed";
  if (v.notYet) return "notYet";
  if (v.count === 0) return "zero";
  return v.capped ? "capped" : "count";
}

/** A breach tile with a real count above zero: gets the danger edge and a visible word. */
export const isBreaching = (spec: TileSpec, v: TileValue): boolean =>
  spec.severity === "breach" && v.count !== null && v.count > 0;

/** Rows of the "Needs attention" strip, most urgent first. */
export const ATTENTION_ORDER: readonly TileId[] = [
  "dsarOverdue", "recon", "brandLate", "suspensions", "approvals", "payoutsStuck", "taxRejected", "brandUnassigned", "kyc", "moderation",
];

export interface AttentionRow {
  readonly id: TileId;
  readonly spec: TileSpec;
  readonly count: number;
  readonly text: string;
  readonly capped: boolean;
  readonly severity: Severity;
}
export type AttentionState = "items" | "clear" | "partial" | "none";
export interface Attention {
  readonly rows: readonly AttentionRow[];
  /** items: something needs attention; clear: every readable tile is zero; partial: nothing to show but a read failed (never "clear"); none: no tile was readable at all. */
  readonly state: AttentionState;
  /** Number of attention rows (distinct things needing action), never a sum of their counts. */
  readonly total: number;
  readonly failedCount: number;
  /** True when any row is a capped lower bound, so the total is "N+". */
  readonly capped: boolean;
}

/** Pure. Only tiles with a real count above zero and severity breach/action appear; failed or dark reads never count as zero. */
export function attentionFor(values: ReadonlyMap<TileId, TileValue>): Attention {
  const rows: AttentionRow[] = [];
  for (const id of ATTENTION_ORDER) {
    const spec = tileSpec(id);
    const v = values.get(id);
    if (spec === undefined || v === undefined || spec.severity === "info") continue;
    if (v.failed || v.notYet || v.count === null || v.count <= 0) continue;
    rows.push({ id, spec, count: v.count, text: v.text, capped: v.capped, severity: spec.severity });
  }
  const all = [...values.values()];
  const failedCount = all.filter((v) => v.failed).length;
  const readable = all.filter((v) => !v.failed && !v.notYet).length;
  const total = rows.length;
  const state: AttentionState = rows.length > 0 ? "items" : failedCount > 0 ? "partial" : readable > 0 ? "clear" : "none";
  return { rows, state, total, failedCount, capped: rows.some((r) => r.capped) };
}

/** Plural bucket for the summary copy (Arabic needs one/two/few/many; English reuses the same text). */
export const summaryKey = (n: number): "one" | "two" | "few" | "many" => (n === 1 ? "one" : n === 2 ? "two" : n >= 3 && n <= 10 ? "few" : "many");
