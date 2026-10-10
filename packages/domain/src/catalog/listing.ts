import { DomainError } from "../errors";
import type { Condition, Issue, ListingStatus } from "./types";
import { containsArabicLetter } from "./text";

export const LISTING_EVENTS = ["publish", "pause", "resume", "auto_pause_price_parity", "delist"] as const;
export type ListingEvent = (typeof LISTING_EVENTS)[number];

/** Who may fire an event. `system` events (price parity) are never reachable from a seller route. */
export type ListingActor = "seller" | "system";

export class InvalidListingTransitionError extends DomainError {
  constructor(
    readonly from: ListingStatus,
    readonly event: ListingEvent,
  ) {
    super(`listing cannot go from ${from} on ${event}`);
  }
}

interface Edge {
  readonly to: ListingStatus;
  readonly actors: readonly ListingActor[];
}

const TABLE: Readonly<Record<ListingStatus, Readonly<Partial<Record<ListingEvent, Edge>>>>> = {
  draft: {
    publish: { to: "active", actors: ["seller", "system"] },
    delist: { to: "delisted", actors: ["seller", "system"] },
  },
  active: {
    pause: { to: "paused", actors: ["seller", "system"] },
    auto_pause_price_parity: { to: "auto_paused_price_parity", actors: ["system"] },
    delist: { to: "delisted", actors: ["seller", "system"] },
  },
  paused: {
    resume: { to: "active", actors: ["seller", "system"] },
    auto_pause_price_parity: { to: "auto_paused_price_parity", actors: ["system"] },
    delist: { to: "delisted", actors: ["seller", "system"] },
  },
  auto_paused_price_parity: {
    resume: { to: "active", actors: ["system"] },
    delist: { to: "delisted", actors: ["seller", "system"] },
  },
  delisted: {},
};

export function nextListingStatus(from: ListingStatus, event: ListingEvent, actor: ListingActor): ListingStatus {
  const edge = TABLE[from][event];
  if (edge === undefined || !edge.actors.includes(actor)) throw new InvalidListingTransitionError(from, event);
  return edge.to;
}

export function allowedListingEvents(from: ListingStatus, actor: ListingActor): readonly ListingEvent[] {
  return LISTING_EVENTS.filter((e) => {
    const edge = TABLE[from][e];
    return edge !== undefined && edge.actors.includes(actor);
  });
}

export function isTerminalListingStatus(s: ListingStatus): boolean {
  return Object.keys(TABLE[s]).length === 0;
}

export type SizeChartStatus = "none" | "unvalidated" | "validated";

export interface PublishCandidate {
  readonly titleAr: string;
  readonly descriptionAr: string | undefined;
  readonly condition: Condition;
  readonly imageCount: number;
  readonly defectPhotoCount: number;
  readonly pricedSkuCount: number;
  readonly categoryRequiresSizeChart: boolean;
  readonly sizeChartStatus: SizeChartStatus;
}

/** Publish gate (spec section 2.4). Returns the unmet requirements; empty means publishable. */
export function publishBlockers(c: PublishCandidate): readonly Issue[] {
  const out: Issue[] = [];
  if (!containsArabicLetter(c.titleAr)) out.push({ pointer: "/title/ar", code: "arabic_text_required" });
  if (c.descriptionAr === undefined || !containsArabicLetter(c.descriptionAr)) {
    out.push({ pointer: "/description/ar", code: "arabic_text_required" });
  }
  if (c.imageCount < 1) out.push({ pointer: "/image_upload_ids", code: "not_publishable" });
  if (c.pricedSkuCount < 1) out.push({ pointer: "/skus", code: "sku_required" });
  if (c.condition === "minor_defect" && c.defectPhotoCount < 1) {
    out.push({ pointer: "/defect_photo_upload_ids", code: "defect_photo_required" });
  }
  if (c.categoryRequiresSizeChart && c.sizeChartStatus !== "validated") {
    out.push({ pointer: "/size_chart_id", code: "not_publishable" });
  }
  return out;
}
