import { z } from "zod";
import {
  code,
  coinSource,
  dropType,
  durationMs,
  gameKind,
  gameOutcomeKind,
  recommendationModule,
  stylistSource,
  adSurface,
  bannerCtaKind,
  categoryWindowSource,
  checkoutStep,
  filterSurface,
  homeSection,
  suggestionKind,
  minorUnits,
  notificationChannel,
  onboardingStep,
  opaqueId,
  paymentMethod,
  plusPlan,
  positiveQuantity,
  refundRoute,
  returnReason,
  smallCount,
  unitInterval,
  wishlistIntent,
  world,
} from "./fields";
import { assertAnalyticsEventName, assertPropertyName } from "./naming";
import type { AnalyticsSafeClass } from "./pii";
import { consentPurposeSchema, type ConsentPurpose, type EventPurpose } from "./purposes";
import type { OwnerModule } from "./modules";
import type { RetentionPolicyId } from "./retention";

type Gate =
  | { readonly origin: "client"; readonly purpose: ConsentPurpose }
  // strictly_necessary is only expressible for server-origin events.
  | { readonly origin: "server"; readonly purpose: EventPurpose };

type FieldClasses<S extends z.ZodRawShape> = { readonly [K in keyof S]: AnalyticsSafeClass };

type Definition<S extends z.ZodRawShape> = Gate & {
  readonly owner: OwnerModule;
  readonly retention: RetentionPolicyId;
  readonly description: string;
  /** Where the event is named in the master prompt. */
  readonly specRef: string;
  /** Schema version of this event's property set. Bump on any breaking change; additive optional fields keep it. */
  readonly version?: number;
  readonly shape: S;
  /** Every property must be classified P0 or P1. P2/P3 are not assignable, so a personal field cannot be declared. */
  readonly classes: FieldClasses<S>;
};

function defineEvent<const N extends string, S extends z.ZodRawShape>(name: N, def: Definition<S>) {
  assertAnalyticsEventName(name);
  for (const key of Object.keys(def.shape)) assertPropertyName(key);
  const piiClass: AnalyticsSafeClass = Object.values<AnalyticsSafeClass>(def.classes).includes("P1") ? "P1" : "P0";
  return { name, ...def, version: def.version ?? 1, piiClass, schema: z.strictObject(def.shape) };
}

const R = "analytics_25m" as const;

/**
 * The analytics event catalog (spec §26 plus every analytics event named in an A3 "Events" block).
 * Properties are allow-listed and strict: an unknown key is a validation error.
 *
 * Values marked "proposed" (enum members, bounded codes) are not fixed by the spec and must be
 * confirmed by the owning module's spec.
 */
export const analyticsEvents = {
  app_open: defineEvent("app_open", {
    owner: "app-shell", origin: "client", purpose: "analytics", retention: R, specRef: "§26",
    description: "App process foregrounded.",
    shape: { launch_type: z.enum(["cold", "warm"]), source: code },
    classes: { launch_type: "P0", source: "P0" },
  }),
  onboarding_step_completed: defineEvent("onboarding_step_completed", {
    owner: "identity", origin: "client", purpose: "analytics", retention: R, specRef: "§1, §26",
    description: "An onboarding step was completed or skipped.",
    shape: { step: onboardingStep, skipped: z.boolean() },
    classes: { step: "P0", skipped: "P0" },
  }),
  world_selected: defineEvent("world_selected", {
    owner: "catalog", origin: "client", purpose: "personalization", retention: R, specRef: "§3, §26",
    description: "The shopper switched the Choose-your-world segment.",
    shape: { world, previous_world: world.optional() },
    classes: { world: "P1", previous_world: "P1" },
  }),
  store_viewed: defineEvent("store_viewed", {
    owner: "catalog", origin: "client", purpose: "analytics", retention: R, specRef: "§3, §26",
    description: "A store page was opened.",
    shape: { store_id: opaqueId, world, source: code },
    classes: { store_id: "P1", world: "P1", source: "P0" },
  }),
  product_viewed: defineEvent("product_viewed", {
    owner: "catalog", origin: "client", purpose: "analytics", retention: R, specRef: "§5, §26",
    description: "A product detail page was opened.",
    shape: { product_id: opaqueId, store_id: opaqueId, source: code, position: smallCount.optional() },
    classes: { product_id: "P1", store_id: "P1", source: "P0", position: "P0" },
  }),
  filter_applied: defineEvent("filter_applied", {
    owner: "search", origin: "client", purpose: "analytics", retention: R, specRef: "§4, §26",
    description: "A filter was applied. Filter values are not recorded, only their count.",
    shape: { filter_key: code, value_count: smallCount, result_count: smallCount, surface: filterSurface.optional() },
    classes: { filter_key: "P0", value_count: "P0", result_count: "P0", surface: "P0" },
  }),
  filter_sheet_opened: defineEvent("filter_sheet_opened", {
    owner: "search", origin: "client", purpose: "analytics", retention: R, specRef: "§4, round-2 item 6",
    description: "The shared filter sheet was opened from a listing's filter icon.",
    shape: { surface: filterSurface },
    classes: { surface: "P0" },
  }),
  filter_reset: defineEvent("filter_reset", {
    owner: "search", origin: "client", purpose: "analytics", retention: R, specRef: "§4, round-2 item 6",
    description: "Reset was pressed in the filter sheet.",
    shape: { surface: filterSurface },
    classes: { surface: "P0" },
  }),
  filter_chip_removed: defineEvent("filter_chip_removed", {
    owner: "search", origin: "client", purpose: "analytics", retention: R, specRef: "§4, round-2 item 6",
    description: "An applied-filter chip was removed. Only the filter key, never its value.",
    shape: { filter_key: code },
    classes: { filter_key: "P0" },
  }),
  search_suggestion_tapped: defineEvent("search_suggestion_tapped", {
    owner: "search", origin: "client", purpose: "analytics", retention: R, specRef: "§4, round-2 item 8",
    description: "A search suggestion was tapped. No suggestion text.",
    shape: { kind: suggestionKind, position: smallCount },
    classes: { kind: "P0", position: "P0" },
  }),
  category_window_opened: defineEvent("category_window_opened", {
    owner: "catalog", origin: "client", purpose: "analytics", retention: R, specRef: "§3, round-2 item 2",
    description: "The category window (subcategory bottom sheet) was opened.",
    shape: { category_id: opaqueId, source: categoryWindowSource },
    classes: { category_id: "P1", source: "P0" },
  }),
  category_window_selected: defineEvent("category_window_selected", {
    owner: "catalog", origin: "client", purpose: "analytics", retention: R, specRef: "§3, round-2 item 2",
    description: "A row of the category window was chosen. has_count says whether the API supplied a count.",
    shape: { category_id: opaqueId, has_count: z.boolean() },
    classes: { category_id: "P1", has_count: "P0" },
  }),
  home_section_viewed: defineEvent("home_section_viewed", {
    owner: "catalog", origin: "client", purpose: "analytics", retention: R, specRef: "round-2 item 4",
    description: "A Home section was shown (once per session).",
    shape: { section: homeSection },
    classes: { section: "P0" },
  }),
  home_section_see_all: defineEvent("home_section_see_all", {
    owner: "catalog", origin: "client", purpose: "analytics", retention: R, specRef: "round-2 item 4",
    description: "See all was tapped on a Home section.",
    shape: { section: homeSection },
    classes: { section: "P0" },
  }),
  checkout_step_viewed: defineEvent("checkout_step_viewed", {
    owner: "checkout", origin: "client", purpose: "analytics", retention: R, specRef: "§7, ADR-0053",
    description: "A checkout step page was shown.",
    shape: { step: checkoutStep, store_count: smallCount },
    classes: { step: "P0", store_count: "P0" },
  }),
  checkout_step_completed: defineEvent("checkout_step_completed", {
    owner: "checkout", origin: "client", purpose: "analytics", retention: R, specRef: "§7, ADR-0053",
    description: "Continue was pressed on a checkout step.",
    shape: { step: checkoutStep, ms_on_step: durationMs },
    classes: { step: "P0", ms_on_step: "P0" },
  }),
  wishlist_item_removed: defineEvent("wishlist_item_removed", {
    owner: "wishlist", origin: "client", purpose: "analytics", retention: R, specRef: "§8, round-2 item 9",
    description: "A saved item was removed (after the undo window).",
    shape: { intent: wishlistIntent },
    classes: { intent: "P1" },
  }),
  wishlist_add_to_bag: defineEvent("wishlist_add_to_bag", {
    owner: "wishlist", origin: "client", purpose: "analytics", retention: R, specRef: "§8, round-2 item 9",
    description: "Add to bag was pressed on a saved item.",
    shape: { intent: wishlistIntent, cool_off: z.boolean() },
    classes: { intent: "P1", cool_off: "P0" },
  }),
  wishlist_shared: defineEvent("wishlist_shared", {
    owner: "wishlist", origin: "client", purpose: "analytics", retention: R, specRef: "§8, round-2 item 9",
    description: "A gift or birthday list share link was created.",
    shape: { intent: wishlistIntent },
    classes: { intent: "P1" },
  }),
  search_performed: defineEvent("search_performed", {
    owner: "search", origin: "client", purpose: "analytics", retention: R, specRef: "§4, §26",
    description: "A search ran. The query text is deliberately NOT a property: queries can contain names, phones and addresses.",
    shape: { term_char_count: z.number().int().min(0).max(200), result_count: smallCount, scope: world.or(z.literal("discover_inline")), has_filters: z.boolean() },
    classes: { term_char_count: "P0", result_count: "P0", scope: "P1", has_filters: "P0" },
  }),
  search_no_result: defineEvent("search_no_result", {
    owner: "search", origin: "client", purpose: "analytics", retention: R, specRef: "§4, §26",
    description: "A search returned nothing. No query text, see search_performed.",
    shape: { term_char_count: z.number().int().min(0).max(200), scope: world, has_filters: z.boolean() },
    classes: { term_char_count: "P0", scope: "P1", has_filters: "P0" },
  }),
  size_recommended: defineEvent("size_recommended", {
    owner: "fit", origin: "server", purpose: "measurements", retention: R, specRef: "§5, §10, §26",
    description: "The fit engine recommended a size. Derived from measurements, so it needs the measurements purpose. No measurement values.",
    shape: { product_id: opaqueId, confidence: unitInterval },
    classes: { product_id: "P1", confidence: "P1" },
  }),
  fit_feedback_submitted: defineEvent("fit_feedback_submitted", {
    owner: "fit", origin: "client", purpose: "measurements", retention: R, specRef: "§10, §26",
    description: "The shopper reported how an item fit (proposed outcome values).",
    shape: { product_id: opaqueId, fit_outcome: z.enum(["too_small", "true_to_size", "too_large"]) },
    classes: { product_id: "P1", fit_outcome: "P1" },
  }),
  stylist_outfit_generated: defineEvent("stylist_outfit_generated", {
    owner: "stylist", origin: "server", purpose: "personalization", retention: R, specRef: "§11, §26",
    description: "The stylist produced outfits. The budget amount is not recorded, only whether one was used.",
    shape: {
      outfit_count: smallCount, budget_used: z.boolean(), latency_ms: durationMs, model_version: code,
      budget_band_index: z.number().int().min(0).max(99).optional(), source: stylistSource.optional(),
    },
    classes: { outfit_count: "P0", budget_used: "P1", latency_ms: "P0", model_version: "P0", budget_band_index: "P1", source: "P0" },
  }),
  outfit_added_to_bag: defineEvent("outfit_added_to_bag", {
    owner: "stylist", origin: "client", purpose: "personalization", retention: R, specRef: "§11, §26",
    description: "A stylist outfit was added to the bag.",
    shape: { outfit_id: opaqueId, item_count: smallCount },
    classes: { outfit_id: "P1", item_count: "P0" },
  }),
  stylist_feedback: defineEvent("stylist_feedback", {
    owner: "stylist", origin: "client", purpose: "personalization", retention: R, specRef: "§11",
    description: "Thumbs feedback on an outfit (proposed values).",
    shape: { outfit_id: opaqueId, rating: z.enum(["positive", "negative"]) },
    classes: { outfit_id: "P1", rating: "P1" },
  }),
  affordability_view_opened: defineEvent("affordability_view_opened", {
    owner: "budget", origin: "client", purpose: "budget_insights", retention: R, specRef: "§12, §26",
    description: "The What-can-I-afford-now view was opened.",
    shape: { entry_point: code },
    classes: { entry_point: "P0" },
  }),
  budget_set: defineEvent("budget_set", {
    owner: "budget", origin: "client", purpose: "budget_insights", retention: R, specRef: "§12, §26",
    description: "A budget was set. The amount is not recorded: only an index into admin-configured bands.",
    shape: { budget_band_index: z.number().int().min(0).max(99), cap_enabled: z.boolean() },
    classes: { budget_band_index: "P1", cap_enabled: "P1" },
  }),
  budget_warning_shown: defineEvent("budget_warning_shown", {
    owner: "budget", origin: "client", purpose: "budget_insights", retention: R, specRef: "§12, §26",
    description: "A budget warning was displayed.",
    shape: { threshold_pct: z.number().int().min(0).max(500) },
    classes: { threshold_pct: "P1" },
  }),
  budget_cap_blocked_checkout: defineEvent("budget_cap_blocked_checkout", {
    owner: "budget", origin: "client", purpose: "budget_insights", retention: R, specRef: "§12, §26",
    description: "The shopper's own budget cap stopped a checkout.",
    shape: { bag_line_count: smallCount },
    classes: { bag_line_count: "P0" },
  }),
  wishlist_added: defineEvent("wishlist_added", {
    owner: "wishlist", origin: "client", purpose: "analytics", retention: R, specRef: "§8, §26",
    description: "An item was saved with an intent.",
    shape: { product_id: opaqueId, intent: wishlistIntent },
    classes: { product_id: "P1", intent: "P1" },
  }),
  wishlist_alert_sent: defineEvent("wishlist_alert_sent", {
    owner: "notifications", origin: "server", purpose: "analytics", retention: R, specRef: "§8",
    description: "A wishlist alert was dispatched. Sending itself is gated separately by the marketing_* purposes in the notifications module.",
    shape: { alert_type: z.enum(["price_drop", "back_in_size", "low_stock", "date_approaching"]), channel: notificationChannel },
    classes: { alert_type: "P0", channel: "P0" },
  }),
  gift_purchase_from_list: defineEvent("gift_purchase_from_list", {
    owner: "wishlist", origin: "server", purpose: "strictly_necessary", retention: R, specRef: "§8",
    description: "A friend bought from, or chipped into, a shared list. Server mirror of a committed transaction. No recipient or address.",
    shape: { wishlist_id: opaqueId, mode: z.enum(["buy", "chip_in"]) },
    classes: { wishlist_id: "P1", mode: "P0" },
  }),
  add_to_bag: defineEvent("add_to_bag", {
    owner: "bag", origin: "client", purpose: "analytics", retention: R, specRef: "§6, §26",
    description: "A SKU was added to the bag.",
    shape: { product_id: opaqueId, sku_id: opaqueId, store_id: opaqueId, quantity: positiveQuantity, source: code },
    classes: { product_id: "P1", sku_id: "P1", store_id: "P1", quantity: "P0", source: "P0" },
  }),
  free_delivery_unlocked: defineEvent("free_delivery_unlocked", {
    owner: "bag", origin: "client", purpose: "analytics", retention: R, specRef: "§6, §26",
    description: "The bag crossed a store's free-delivery threshold.",
    shape: { store_id: opaqueId },
    classes: { store_id: "P1" },
  }),
  checkout_started: defineEvent("checkout_started", {
    owner: "checkout", origin: "client", purpose: "analytics", retention: R, specRef: "§7, §26",
    description: "Checkout was opened.",
    shape: { bag_line_count: smallCount, store_count: smallCount, total_minor: minorUnits },
    classes: { bag_line_count: "P0", store_count: "P0", total_minor: "P1" },
  }),
  payment_selected: defineEvent("payment_selected", {
    owner: "checkout", origin: "client", purpose: "analytics", retention: R, specRef: "§7, §26",
    description: "A payment method was chosen.",
    shape: { method: paymentMethod, split_tender: z.boolean() },
    classes: { method: "P1", split_tender: "P1" },
  }),
  order_placed: defineEvent("order_placed", {
    owner: "checkout", origin: "server", purpose: "strictly_necessary", retention: R, specRef: "§7, §26",
    description: "An order group was placed. Pseudonymous server mirror of order_group.placed.",
    shape: { order_group_id: opaqueId, seller_order_count: smallCount, line_count: smallCount, total_minor: minorUnits, payment_method: paymentMethod },
    classes: { order_group_id: "P1", seller_order_count: "P0", line_count: "P0", total_minor: "P1", payment_method: "P1" },
  }),
  order_delivered: defineEvent("order_delivered", {
    owner: "checkout", origin: "server", purpose: "strictly_necessary", retention: R, specRef: "§21, §26",
    description: "A seller order was delivered (courier-confirmed).",
    shape: { seller_order_id: opaqueId, delivery_attempts: z.number().int().min(1).max(3) },
    classes: { seller_order_id: "P1", delivery_attempts: "P0" },
  }),
  return_requested: defineEvent("return_requested", {
    owner: "returns", origin: "server", purpose: "strictly_necessary", retention: R, specRef: "§22, §26",
    description: "A return was requested. Reason is a taxonomy value, never free text.",
    shape: { return_id: opaqueId, reason: returnReason },
    classes: { return_id: "P1", reason: "P1" },
  }),
  refund_completed: defineEvent("refund_completed", {
    owner: "refunds", origin: "server", purpose: "strictly_necessary", retention: R, specRef: "§15.6, §22, §26",
    description: "A refund completed. Pseudonymous server mirror of refund.completed.",
    shape: { refund_id: opaqueId, route: refundRoute, amount_minor: minorUnits },
    classes: { refund_id: "P1", route: "P1", amount_minor: "P1" },
  }),
  home_banner_impression: defineEvent("home_banner_impression", {
    owner: "catalog", origin: "client", purpose: "analytics", retention: R, specRef: "§16, §26",
    description: "A home offer banner became visible (once per banner per carousel mount). Opaque banner id and slot only: no user, query or budget data.",
    shape: { banner_id: opaqueId, position: smallCount, sponsored: z.boolean(), cta_kind: bannerCtaKind },
    classes: { banner_id: "P1", position: "P0", sponsored: "P0", cta_kind: "P0" },
  }),
  home_banner_click: defineEvent("home_banner_click", {
    owner: "catalog", origin: "client", purpose: "analytics", retention: R, specRef: "§16, §26",
    description: "A home offer banner was tapped. Same properties as the impression.",
    shape: { banner_id: opaqueId, position: smallCount, sponsored: z.boolean(), cta_kind: bannerCtaKind },
    classes: { banner_id: "P1", position: "P0", sponsored: "P0", cta_kind: "P0" },
  }),
  price_badge_viewed: defineEvent("price_badge_viewed", {
    owner: "price-integrity", origin: "client", purpose: "analytics", retention: R, specRef: "§5, §9, §26",
    description: "A price-integrity badge was shown. badge_type is a bounded code until §9 fixes the badge set.",
    shape: { product_id: opaqueId, badge_type: code },
    classes: { product_id: "P1", badge_type: "P0" },
  }),
  price_reported: defineEvent("price_reported", {
    owner: "price-integrity", origin: "client", purpose: "analytics", retention: R, specRef: "§9, §26",
    description: "A shopper reported a price. No free-text comment.",
    shape: { product_id: opaqueId, report_kind: code },
    classes: { product_id: "P1", report_kind: "P0" },
  }),
  plus_paywall_viewed: defineEvent("plus_paywall_viewed", {
    owner: "plus", origin: "client", purpose: "analytics", retention: R, specRef: "§14, §26",
    description: "The Plus paywall was shown.",
    shape: { entry_point: code },
    classes: { entry_point: "P0" },
  }),
  plus_started: defineEvent("plus_started", {
    owner: "plus", origin: "server", purpose: "strictly_necessary", retention: R, specRef: "§14, §26",
    description: "A Plus subscription or trial started.",
    shape: { plan: plusPlan, trial: z.boolean() },
    classes: { plan: "P1", trial: "P1" },
  }),
  plus_renewed: defineEvent("plus_renewed", {
    owner: "plus", origin: "server", purpose: "strictly_necessary", retention: R, specRef: "§14",
    description: "A Plus subscription renewed.",
    shape: { plan: plusPlan },
    classes: { plan: "P1" },
  }),
  plus_payment_failed: defineEvent("plus_payment_failed", {
    owner: "plus", origin: "server", purpose: "strictly_necessary", retention: R, specRef: "§14",
    description: "A Plus renewal charge failed.",
    shape: { attempt: z.number().int().min(1).max(10) },
    classes: { attempt: "P0" },
  }),
  plus_cancelled: defineEvent("plus_cancelled", {
    owner: "plus", origin: "server", purpose: "strictly_necessary", retention: R, specRef: "§14, §26",
    description: "A Plus subscription was cancelled. The reason is a bounded code, never free text.",
    shape: { plan: plusPlan, reason: code },
    classes: { plan: "P1", reason: "P1" },
  }),
  gift_card_purchased: defineEvent("gift_card_purchased", {
    owner: "gift-cards", origin: "server", purpose: "strictly_necessary", retention: R, specRef: "§15.1, §26",
    description: "A gift card was bought. No recipient details.",
    shape: { amount_minor: minorUnits, group_gift: z.boolean() },
    classes: { amount_minor: "P1", group_gift: "P1" },
  }),
  gift_card_redeemed: defineEvent("gift_card_redeemed", {
    owner: "gift-cards", origin: "server", purpose: "strictly_necessary", retention: R, specRef: "§15.1, §26",
    description: "A gift card was redeemed.",
    shape: { amount_minor: minorUnits },
    classes: { amount_minor: "P1" },
  }),
  referral_shared: defineEvent("referral_shared", {
    owner: "referrals", origin: "client", purpose: "analytics", retention: R, specRef: "§15.4, §26",
    description: "A referral link or code was shared. The target app or contact is not recorded.",
    shape: { surface: code },
    classes: { surface: "P0" },
  }),
  referral_converted: defineEvent("referral_converted", {
    owner: "referrals", origin: "server", purpose: "strictly_necessary", retention: R, specRef: "§15.4, §26",
    description: "A referred friend completed the qualifying action.",
    shape: { referral_id: opaqueId },
    classes: { referral_id: "P1" },
  }),
  coins_earned: defineEvent("coins_earned", {
    owner: "rewards", origin: "server", purpose: "strictly_necessary", retention: R, specRef: "§15.5, §26",
    description: "Coins were credited.",
    shape: { coins: z.number().int().min(1).max(10_000_000), source: coinSource },
    classes: { coins: "P1", source: "P1" },
  }),
  drop_joined_queue: defineEvent("drop_joined_queue", {
    owner: "drops", origin: "server", purpose: "strictly_necessary", retention: R, specRef: "§16, §26",
    description: "A shopper joined a drop waiting room.",
    shape: { drop_id: opaqueId, drop_type: dropType },
    classes: { drop_id: "P1", drop_type: "P0" },
  }),
  drop_admitted: defineEvent("drop_admitted", {
    owner: "drops", origin: "server", purpose: "strictly_necessary", retention: R, specRef: "§16, §26",
    description: "A shopper was admitted from the waiting room.",
    shape: { drop_id: opaqueId, wait_seconds: z.number().int().min(0).max(86_400) },
    classes: { drop_id: "P1", wait_seconds: "P0" },
  }),
  game_played: defineEvent("game_played", {
    owner: "rewards", origin: "server", purpose: "strictly_necessary", retention: R, specRef: "§15.5, phase2/06",
    description: "A free light game was played. Odds were disclosed (always true) and the outcome is coins or a voucher, never cash.",
    shape: { game: gameKind, odds_version: code, odds_disclosed: z.literal(true), outcome_kind: gameOutcomeKind },
    classes: { game: "P0", odds_version: "P0", odds_disclosed: "P0", outcome_kind: "P1" },
  }),
  recommendation_impression: defineEvent("recommendation_impression", {
    owner: "recommendations", origin: "client", purpose: "personalization", retention: R, specRef: "phase2/05",
    description: "A recommendation module was shown.",
    shape: { module: recommendationModule, model_version: code, item_count: smallCount, personalized: z.boolean(), surface: code.optional() },
    classes: { module: "P0", model_version: "P0", item_count: "P0", personalized: "P1", surface: "P0" },
  }),
  recommendation_click: defineEvent("recommendation_click", {
    owner: "recommendations", origin: "client", purpose: "personalization", retention: R, specRef: "phase2/05",
    description: "An item in a recommendation module was opened.",
    shape: { module: recommendationModule, model_version: code, product_id: opaqueId, position: smallCount, surface: code.optional() },
    classes: { module: "P0", model_version: "P0", product_id: "P1", position: "P0", surface: "P0" },
  }),
  history_cleared: defineEvent("history_cleared", {
    owner: "recommendations", origin: "server", purpose: "strictly_necessary", retention: R, specRef: "§13, phase2/05",
    description: "The shopper cleared their history. Server mirror of history.cleared, no content.",
    shape: { scope: z.enum(["all", "viewed", "searched"]) },
    classes: { scope: "P0" },
  }),
  personalization_changed: defineEvent("personalization_changed", {
    owner: "recommendations", origin: "server", purpose: "strictly_necessary", retention: R, specRef: "§13, phase2/05",
    description: "The personalization toggle changed. Strictly necessary so withdrawal is always recorded.",
    shape: { enabled: z.boolean() },
    classes: { enabled: "P0" },
  }),
  ad_impression: defineEvent("ad_impression", {
    owner: "ads", origin: "server", purpose: "strictly_necessary", retention: R, specRef: "§17, phase2/10",
    description: "A sponsored result was served. Pseudonymous, no user id and no query text. Needed for billing and reporting.",
    shape: { ad_id: opaqueId, campaign_id: opaqueId, surface: adSurface, position: smallCount },
    classes: { ad_id: "P1", campaign_id: "P1", surface: "P0", position: "P0" },
  }),
  ad_click: defineEvent("ad_click", {
    owner: "ads", origin: "server", purpose: "strictly_necessary", retention: R, specRef: "§17, phase2/10",
    description: "A sponsored result was clicked (server-validated token, billed only if valid).",
    shape: { ad_id: opaqueId, campaign_id: opaqueId, surface: adSurface, position: smallCount, valid: z.boolean() },
    classes: { ad_id: "P1", campaign_id: "P1", surface: "P0", position: "P0", valid: "P0" },
  }),
  review_submitted: defineEvent("review_submitted", {
    owner: "reviews", origin: "server", purpose: "strictly_necessary", retention: R, specRef: "§27, §15.5",
    description: "A verified-purchase review was submitted. Rating and flags only, no review text.",
    shape: { product_id: opaqueId, rating: z.number().int().min(1).max(5), has_image: z.boolean(), has_size_info: z.boolean() },
    classes: { product_id: "P1", rating: "P1", has_image: "P0", has_size_info: "P0" },
  }),
  review_reported: defineEvent("review_reported", {
    owner: "reviews", origin: "client", purpose: "analytics", retention: R, specRef: "§27",
    description: "A review was reported. Reason is a bounded code, no free text.",
    shape: { review_id: opaqueId, reason: code },
    classes: { review_id: "P1", reason: "P0" },
  }),
  consent_changed: defineEvent("consent_changed", {
    owner: "privacy", origin: "server", purpose: "strictly_necessary", retention: R, specRef: "§B1, §26",
    description: "A consent was granted or withdrawn. Must be emitted on withdrawal too, so it can never depend on the purpose it reports.",
    shape: { purpose: consentPurposeSchema, granted: z.boolean(), consent_version: code, method: code },
    classes: { purpose: "P1", granted: "P1", consent_version: "P0", method: "P0" },
  }),
} as const;

export type AnalyticsEventCatalog = typeof analyticsEvents;
export type AnalyticsEventName = keyof AnalyticsEventCatalog;
/** What a caller passes (before Zod defaults/transforms). */
export type AnalyticsEventInput<N extends AnalyticsEventName> = z.input<AnalyticsEventCatalog[N]["schema"]>;
export type AnalyticsEventProperties<N extends AnalyticsEventName> = z.output<AnalyticsEventCatalog[N]["schema"]>;

export const ANALYTICS_EVENT_NAMES = Object.keys(analyticsEvents) as AnalyticsEventName[];

export function isAnalyticsEventName(name: unknown): name is AnalyticsEventName {
  return typeof name === "string" && Object.hasOwn(analyticsEvents, name);
}
