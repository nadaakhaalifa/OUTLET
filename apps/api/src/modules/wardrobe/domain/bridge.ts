/**
 * Single seam to the pure stylist and calendar domains (packages/domain). Aliases only, no behaviour.
 * The wardrobe reuses the calendar's gap planner: an owned item is a locked, zero-price slot that the
 * optimizer never counts against the budget (spec 28 feature 4; spec 11).
 */
import { outfitCalendar, stylist } from "@outlet/domain";
export import SLOTS = stylist.SLOTS;
export import SEASONS = stylist.SEASONS;
export import EVENT_KINDS = outfitCalendar.EVENT_KINDS;
export import KIND_FORMALITY = outfitCalendar.KIND_FORMALITY;
export import ownedSlotsConsistent = outfitCalendar.ownedSlotsConsistent;
export import planGap = outfitCalendar.planGap;
export type Slot = stylist.Slot;
export type Season = stylist.Season;
export type EventKind = outfitCalendar.EventKind;
export type GapOutfit = outfitCalendar.GapOutfit;
export type MissingSlot = stylist.MissingSlot;
export type OutfitSource = stylist.OutfitSource;
