import type { FlagWire } from "../api/schemas";
import type { Locale } from "../i18n";
import { EXPECTED_KILL_SWITCHES } from "./flags";

/**
 * ADR-0028: a kill switch is shown as Allowed / Blocked, never on / off. `enabled=true` means the capability
 * is ALLOWED to run; the default is false (Blocked) and every error path fails closed.
 */
export type SwitchState = "allowed" | "blocked";

/** Mirrors PHASE2_KILL_SWITCHES in packages/feature-flags (a test pins keys and descriptions). */
export const PHASE2_SWITCH_KEYS = [
  "kill.plus.sales", "kill.plus.recurring.card", "kill.plus.recurring.mobile_wallet", "kill.plus.recurring.apple_pay",
  "kill.gift_card_redemption", "kill.rewards_coins", "kill.budget_caps", "kill.stylist_ml", "kill.llm_search_parse",
  "kill.sponsored_products", "kill.hub_consolidation", "kill.resale_lane", "kill.waiting_room", "kill.mystery_box",
  "kill.drop_type.public", "kill.drop_type.members_only", "kill.drop_type.flash_hour", "kill.drop_type.mystery_box",
  "kill.drop_type.price_ladder", "kill.drop_type.last_chance", "kill.search_engine",
  "kill.courier.bosta", "kill.courier.aramex", "kill.courier.mylerz",
  "kill.plus.family", "kill.plus.student", "kill.price_drop_auto_buy", "kill.auto_buy.charge", "kill.stylist_chat",
  "kill.visual_search", "kill.demand_forecasting", "kill.calendar_gap_fill", "kill.calendar_reminders",
  "kill.ranking_v2_shadow", "kill.wardrobe", "kill.wardrobe_vision", "kill.creator_program", "kill.creator_payouts", "kill.public_catalog", "kill.odoo_channel",
  "kill.background_removal", "kill.home_banners",
  "kill.analytics.ingest", "kill.analytics.producers", "kill.analytics.consumers",
] as const;

export const ALL_SWITCH_KEYS: readonly string[] = [...EXPECTED_KILL_SWITCHES, ...PHASE2_SWITCH_KEYS];

/** What "Blocked" means for operators (from the registry descriptions, English authoritative for engineers). */
const BLOCKED_EN: Readonly<Record<string, string>> = {
  "kill.plus.sales": "No new subscriptions; existing members keep benefits",
  "kill.plus.recurring.card": "Renewals pause and members are told",
  "kill.plus.recurring.mobile_wallet": "Renewals pause",
  "kill.plus.recurring.apple_pay": "Renewals pause",
  "kill.gift_card_redemption": "Redemption answers 503",
  "kill.rewards_coins": "No new coins, conversions pause",
  "kill.budget_caps": "Caps are not enforced",
  "kill.stylist_ml": "Rule-based outfits (templates, popularity, colour rules)",
  "kill.llm_search_parse": "Plain keyword search",
  "kill.sponsored_products": "No sponsored slots are served or billed",
  "kill.hub_consolidation": "Shipments go out per seller order",
  "kill.resale_lane": "No new listings or sales",
  "kill.waiting_room": "Fails closed, drops are paused",
  "kill.mystery_box": "Mystery boxes cannot be created or bought",
  "kill.drop_type.public": "This drop type cannot be created or opened",
  "kill.drop_type.members_only": "This drop type cannot be created or opened",
  "kill.drop_type.flash_hour": "This drop type cannot be created or opened",
  "kill.drop_type.mystery_box": "This drop type cannot be created or opened",
  "kill.drop_type.price_ladder": "This drop type cannot be created or opened",
  "kill.drop_type.last_chance": "This drop type cannot be created or opened",
  "kill.search_engine": "Postgres FTS fallback with reduced features",
  "kill.courier.bosta": "AWB creation queues and the seller sees label pending",
  "kill.courier.aramex": "AWB creation queues and the seller sees label pending",
  "kill.courier.mylerz": "AWB creation queues and the seller sees label pending",
  "kill.plus.family": "Answers 503 family_unavailable; existing members keep benefits until period end",
  "kill.plus.student": "Answers 503 student_unavailable; renewals follow the stored verification",
  "kill.price_drop_auto_buy": "No new rules, the evaluator does nothing and shoppers see paused; stored rules stay armed",
  "kill.auto_buy.charge": "Shoppers are only notified and no charge call is ever made",
  "kill.stylist_chat": "Chat answers 503 stylist_chat_disabled and the app shows the structured stylist; sessions can still be read and deleted",
  "kill.visual_search": "Image search answers 503 visual_search_disabled and the PDP similar list uses attributes",
  "kill.demand_forecasting": "The nightly batch does nothing and the seller forecast read answers 503 demand_forecasting_disabled; stored forecasts are kept",
  "kill.calendar_gap_fill": "Events still work, outfit generation answers 503 calendar_gap_fill_disabled",
  "kill.calendar_reminders": "Due reminders stay pending and nothing is sent",
  "kill.ranking_v2_shadow": "v2 scores are not computed or logged; v1 serving is unaffected",
  "kill.wardrobe": "Wardrobe writes answer 503 wardrobe_disabled; shoppers can still list, read and delete their items",
  "kill.wardrobe_vision": "Suggest-attributes answers 503 wardrobe_vision_disabled; items are described by hand",
  "kill.creator_program": "No new links or applications, clicks are not attributed and accruals pause; stored data stays readable",
  "kill.creator_payouts": "Accruals continue, no payout instruction is ever created or sent",
  "kill.odoo_channel": "Odoo seller channel polling and connection tests stop: no outbound call to any seller Odoo is made and no stock or price sync runs",
  "kill.background_removal": "Automatic background removal stops: process and re-run answer 503 background_removal_disabled; sellers keep and can use their originals",
  "kill.home_banners": "In-app offer banners are hidden: the Home carousel list is empty; admins can still edit and schedule banners",
  "kill.public_catalog": "Every /v1/public catalog route answers 503 public_catalog_disabled; authenticated routes are unaffected",
  "kill.analytics.ingest": "The ingest route answers 503 analytics_ingest_disabled, the tracker drops batches and counts them; nothing is stored",
  "kill.analytics.producers": "Server producers append no analytics event; checkout, payment and return transitions still commit",
  "kill.analytics.consumers": "The consumers are not registered: events are acknowledged unrouted and stay replayable",
};
const BLOCKED_AR: Readonly<Record<string, string>> = {
  "kill.plus.sales": "لا اشتراكات جديدة؛ الأعضاء الحاليون يحتفظون بمزاياهم",
  "kill.plus.recurring.card": "تتوقف التجديدات ويُبلَّغ الأعضاء",
  "kill.plus.recurring.mobile_wallet": "تتوقف التجديدات",
  "kill.plus.recurring.apple_pay": "تتوقف التجديدات",
  "kill.gift_card_redemption": "يرد الاسترداد بالخطأ 503",
  "kill.rewards_coins": "لا عملات جديدة وتتوقف التحويلات",
  "kill.budget_caps": "لا يتم تطبيق الحدود",
  "kill.stylist_ml": "إطلالات قائمة على القواعد (قوالب وشعبية وألوان)",
  "kill.llm_search_parse": "بحث بالكلمات المفتاحية فقط",
  "kill.sponsored_products": "لا تُعرض مواضع ممولة ولا تُحتسب رسوم",
  "kill.hub_consolidation": "تُشحن الطلبات لكل بائع على حدة",
  "kill.resale_lane": "لا عروض ولا مبيعات جديدة",
  "kill.waiting_room": "يُغلق بأمان وتتوقف الإصدارات",
  "kill.mystery_box": "لا يمكن إنشاء صناديق المفاجآت أو شراؤها",
  "kill.drop_type.public": "لا يمكن إنشاء هذا النوع من الإصدارات أو فتحه",
  "kill.drop_type.members_only": "لا يمكن إنشاء هذا النوع من الإصدارات أو فتحه",
  "kill.drop_type.flash_hour": "لا يمكن إنشاء هذا النوع من الإصدارات أو فتحه",
  "kill.drop_type.mystery_box": "لا يمكن إنشاء هذا النوع من الإصدارات أو فتحه",
  "kill.drop_type.price_ladder": "لا يمكن إنشاء هذا النوع من الإصدارات أو فتحه",
  "kill.drop_type.last_chance": "لا يمكن إنشاء هذا النوع من الإصدارات أو فتحه",
  "kill.search_engine": "بحث Postgres النصي الاحتياطي بميزات أقل",
  "kill.courier.bosta": "يُؤجَّل إنشاء بوليصة الشحن ويرى البائع أن الملصق قيد الانتظار",
  "kill.courier.aramex": "يُؤجَّل إنشاء بوليصة الشحن ويرى البائع أن الملصق قيد الانتظار",
  "kill.courier.mylerz": "يُؤجَّل إنشاء بوليصة الشحن ويرى البائع أن الملصق قيد الانتظار",
  "kill.plus.family": "يرد بالخطأ 503 family_unavailable ويحتفظ الأعضاء الحاليون بمزاياهم حتى نهاية الفترة",
  "kill.plus.student": "يرد بالخطأ 503 student_unavailable وتتبع التجديدات التحقق المخزن",
  "kill.price_drop_auto_buy": "لا قواعد جديدة ولا يعمل المقيّم ويرى المتسوقون حالة الإيقاف؛ تبقى القواعد المخزنة مفعّلة",
  "kill.auto_buy.charge": "يُبلَّغ المتسوقون فقط ولا يُنفَّذ أي خصم",
  "kill.stylist_chat": "ترد المحادثة بالخطأ 503 stylist_chat_disabled ويعرض التطبيق المستشار المنظم؛ يمكن قراءة الجلسات وحذفها",
  "kill.visual_search": "يرد البحث بالصورة بالخطأ 503 visual_search_disabled وتعتمد قائمة المشابه على الخصائص",
  "kill.demand_forecasting": "لا تعمل الدفعة الليلية وترد قراءة التوقع بالخطأ 503 demand_forecasting_disabled؛ تبقى التوقعات المخزنة",
  "kill.calendar_gap_fill": "تعمل المناسبات وترد صناعة الإطلالات بالخطأ 503 calendar_gap_fill_disabled",
  "kill.calendar_reminders": "تبقى التذكيرات المستحقة معلّقة ولا يُرسل شيء",
  "kill.ranking_v2_shadow": "لا تُحسب درجات النسخة الثانية ولا تُسجَّل ولا يتأثر عرض النسخة الأولى",
  "kill.wardrobe": "ترد كتابة الخزانة بالخطأ 503 wardrobe_disabled ويمكن للمتسوقين قراءة عناصرهم وحذفها",
  "kill.wardrobe_vision": "يرد اقتراح الخصائص بالخطأ 503 wardrobe_vision_disabled ويُوصف العنصر يدويا",
  "kill.creator_program": "لا روابط ولا طلبات جديدة ولا يُنسب النقر وتتوقف الاستحقاقات وتبقى البيانات مقروءة",
  "kill.creator_payouts": "تستمر الاستحقاقات ولا تُنشأ أي تعليمات صرف ولا تُرسل",
  "kill.odoo_channel": "يتوقف ربط قناة Odoo واختبارها ومزامنة المخزون والأسعار منها",
  "kill.background_removal": "تتوقف الإزالة التلقائية للخلفية: يرد التشغيل وإعادته بالخطأ 503 ويحتفظ البائعون بصورهم الأصلية ويستخدمونها",
  "kill.home_banners": "تُخفى لافتات العروض داخل التطبيق: تكون قائمة شريط الرئيسية فارغة ويمكن للمشرفين التعديل والجدولة",
  "kill.public_catalog": "ترد كل مسارات الكتالوج العام بالخطأ 503 public_catalog_disabled ولا تتأثر المسارات المصادق عليها",
  "kill.analytics.ingest": "ترد مسارات استقبال التحليلات بالخطأ 503 analytics_ingest_disabled ويُسقط التطبيق الدفعات ويعدّها ولا يُخزَّن شيء",
  "kill.analytics.producers": "لا تُضيف المنتِجات من جهة الخادم أي حدث تحليلي وتظل عمليات الدفع والإرجاع تُنفَّذ كالمعتاد",
  "kill.analytics.consumers": "لا تُسجَّل المستهلكات: تُقرّ الأحداث دون توجيه وتبقى قابلة لإعادة التشغيل",
};
const LABEL_EN: Readonly<Record<string, string>> = {
  "kill.payment.card": "Card payments", "kill.payment.apple_pay": "Apple Pay", "kill.payment.mobile_wallet": "Mobile wallets",
  "kill.payment.instapay": "InstaPay", "kill.payment.fawry": "Fawry", "kill.payment.cod": "Cash on delivery",
  "kill.payment.bnpl": "Installments (BNPL)", "kill.drops": "Drops", "kill.games": "Games", "kill.stylist_llm": "AI stylist (LLM)",
  "kill.ml_ranking": "ML ranking", "kill.crawlers": "Crawlers", "kill.referral_payouts": "Referral payouts", "kill.gift_card_sales": "Gift card sales",
  "kill.plus.sales": "HAUL Plus sales", "kill.plus.recurring.card": "Plus renewals on cards", "kill.plus.recurring.mobile_wallet": "Plus renewals on mobile wallets",
  "kill.plus.recurring.apple_pay": "Plus renewals on Apple Pay", "kill.gift_card_redemption": "Gift card redemption", "kill.rewards_coins": "Coins",
  "kill.budget_caps": "Budget caps", "kill.stylist_ml": "Stylist ML ranking", "kill.llm_search_parse": "LLM search parsing",
  "kill.sponsored_products": "Sponsored products", "kill.hub_consolidation": "Hub consolidation", "kill.resale_lane": "Returns-resale lane",
  "kill.waiting_room": "Waiting room", "kill.mystery_box": "Mystery boxes", "kill.drop_type.public": "Public drops",
  "kill.drop_type.members_only": "Members-only drops", "kill.drop_type.flash_hour": "Flash-hour drops", "kill.drop_type.mystery_box": "Mystery-box drop type",
  "kill.drop_type.price_ladder": "Price-ladder drops", "kill.drop_type.last_chance": "Last-chance drops", "kill.search_engine": "Typesense search engine",
  "kill.courier.bosta": "Bosta courier", "kill.courier.aramex": "Aramex courier", "kill.courier.mylerz": "Mylerz courier",
  "kill.plus.family": "Family plan sales and seat changes",
  "kill.plus.student": "Student plan",
  "kill.price_drop_auto_buy": "Price-drop auto-buy",
  "kill.auto_buy.charge": "Auto-buy unattended charge",
  "kill.stylist_chat": "Stylist chat",
  "kill.visual_search": "Visual search",
  "kill.demand_forecasting": "Demand forecasting",
  "kill.calendar_gap_fill": "Outfit calendar gap fill",
  "kill.calendar_reminders": "Outfit calendar reminders",
  "kill.ranking_v2_shadow": "Ranking v2 shadow scoring",
  "kill.wardrobe": "Wardrobe",
  "kill.wardrobe_vision": "Wardrobe photo suggestions",
  "kill.creator_program": "Creator program",
  "kill.creator_payouts": "Creator payouts",
  "kill.odoo_channel": "Odoo seller channel",
  "kill.background_removal": "Product photo background removal",
  "kill.home_banners": "Home offer banners",
  "kill.public_catalog": "Public catalog",
  "kill.analytics.ingest": "Client analytics ingest",
  "kill.analytics.producers": "Analytics producers (server facts)",
  "kill.analytics.consumers": "Analytics consumers",
};
const LABEL_AR: Readonly<Record<string, string>> = {
  "kill.payment.card": "الدفع بالبطاقة", "kill.payment.apple_pay": "Apple Pay", "kill.payment.mobile_wallet": "محافظ الموبايل",
  "kill.payment.instapay": "إنستاباي", "kill.payment.fawry": "فوري", "kill.payment.cod": "الدفع عند الاستلام",
  "kill.payment.bnpl": "التقسيط", "kill.drops": "الإصدارات", "kill.games": "الألعاب", "kill.stylist_llm": "المستشار الذكي (LLM)",
  "kill.ml_ranking": "الترتيب بالتعلم الآلي", "kill.crawlers": "الزواحف", "kill.referral_payouts": "مدفوعات الإحالة", "kill.gift_card_sales": "بيع بطاقات الهدايا",
  "kill.plus.sales": "مبيعات اشتراك Plus", "kill.plus.recurring.card": "تجديد Plus بالبطاقة", "kill.plus.recurring.mobile_wallet": "تجديد Plus بمحافظ الموبايل",
  "kill.plus.recurring.apple_pay": "تجديد Plus بـ Apple Pay", "kill.gift_card_redemption": "استرداد بطاقات الهدايا", "kill.rewards_coins": "العملات",
  "kill.budget_caps": "حدود الميزانية", "kill.stylist_ml": "ترتيب المستشار بالتعلم الآلي", "kill.llm_search_parse": "تحليل البحث بـ LLM",
  "kill.sponsored_products": "المنتجات الممولة", "kill.hub_consolidation": "تجميع المركز اللوجستي", "kill.resale_lane": "مسار إعادة بيع المرتجعات",
  "kill.waiting_room": "غرفة الانتظار", "kill.mystery_box": "صناديق المفاجآت", "kill.drop_type.public": "الإصدارات العامة",
  "kill.drop_type.members_only": "إصدارات الأعضاء", "kill.drop_type.flash_hour": "إصدارات الساعة الخاطفة", "kill.drop_type.mystery_box": "نوع صندوق المفاجآت",
  "kill.drop_type.price_ladder": "إصدارات السعر المتدرج", "kill.drop_type.last_chance": "إصدارات الفرصة الأخيرة", "kill.search_engine": "محرك البحث Typesense",
  "kill.courier.bosta": "شركة بوسطة", "kill.courier.aramex": "شركة أرامكس", "kill.courier.mylerz": "شركة مايلرز",
  "kill.plus.family": "مبيعات الخطة العائلية",
  "kill.plus.student": "الخطة الطلابية",
  "kill.price_drop_auto_buy": "الشراء التلقائي عند انخفاض السعر",
  "kill.auto_buy.charge": "الخصم التلقائي للشراء التلقائي",
  "kill.stylist_chat": "محادثة المستشار",
  "kill.visual_search": "البحث بالصورة",
  "kill.demand_forecasting": "توقع الطلب",
  "kill.calendar_gap_fill": "ملء فجوات تقويم الإطلالات",
  "kill.calendar_reminders": "تذكيرات تقويم الإطلالات",
  "kill.ranking_v2_shadow": "التسجيل الظلي لترتيب النسخة الثانية",
  "kill.wardrobe": "الخزانة الرقمية",
  "kill.wardrobe_vision": "اقتراحات الخزانة من الصور",
  "kill.creator_program": "برنامج صانعي المحتوى",
  "kill.creator_payouts": "مدفوعات صانعي المحتوى",
  "kill.odoo_channel": "قناة Odoo",
  "kill.background_removal": "إزالة خلفية صور المنتجات",
  "kill.home_banners": "لافتات العروض في الرئيسية",
  "kill.public_catalog": "الكتالوج العام",
  "kill.analytics.ingest": "استقبال تحليلات التطبيق",
  "kill.analytics.producers": "منتِجات التحليلات (حقائق الخادم)",
  "kill.analytics.consumers": "مستهلكات التحليلات",
};

export interface KillSwitchRow {
  readonly key: string;
  readonly label: string;
  readonly state: SwitchState;
  readonly isDefault: boolean;
  /** Plain consequence of Blocked for this capability, when known. */
  readonly blockedMeans: string | null;
  /** Value a change would send (`enabled`). */
  readonly nextEnabled: boolean;
  readonly nextState: SwitchState;
  readonly group: SwitchGroup;
}

export const SWITCH_GROUPS = ["payments", "plus", "gift_cards", "rewards", "drops", "discovery", "creators", "logistics", "other"] as const;
export type SwitchGroup = (typeof SWITCH_GROUPS)[number];

export function groupOf(key: string): SwitchGroup {
  if (key.startsWith("kill.payment.")) return "payments";
  if (key.startsWith("kill.plus.") || key.startsWith("kill.auto_buy.") || key === "kill.price_drop_auto_buy") return "plus";
  if (key === "kill.gift_card_sales" || key === "kill.gift_card_redemption") return "gift_cards";
  if (key === "kill.games" || key === "kill.rewards_coins") return "rewards";
  if (key === "kill.drops" || key === "kill.waiting_room" || key === "kill.mystery_box" || key.startsWith("kill.drop_type.")) return "drops";
  if (["kill.stylist_llm", "kill.ml_ranking", "kill.stylist_ml", "kill.llm_search_parse", "kill.search_engine", "kill.sponsored_products", "kill.crawlers", "kill.stylist_chat", "kill.visual_search", "kill.demand_forecasting", "kill.calendar_gap_fill", "kill.calendar_reminders", "kill.ranking_v2_shadow", "kill.wardrobe", "kill.wardrobe_vision", "kill.public_catalog", "kill.odoo_channel", "kill.home_banners"].includes(key)) return "discovery";
  if (key.startsWith("kill.creator_")) return "creators";
  if (key.startsWith("kill.courier.") || key === "kill.hub_consolidation" || key === "kill.resale_lane") return "logistics";
  return "other";
}

export const stateOf = (enabled: boolean): SwitchState => (enabled ? "allowed" : "blocked");

export function switchLabel(key: string, locale: Locale): string {
  return (locale === "ar" ? LABEL_AR : LABEL_EN)[key] ?? key;
}

export function toRow(f: FlagWire, locale: Locale): KillSwitchRow {
  return {
    key: f.key,
    label: switchLabel(f.key, locale),
    state: stateOf(f.enabled),
    isDefault: f.is_default,
    blockedMeans: (locale === "ar" ? BLOCKED_AR : BLOCKED_EN)[f.key] ?? null,
    nextEnabled: !f.enabled,
    nextState: stateOf(!f.enabled),
    group: groupOf(f.key),
  };
}

export interface KillSwitchBoard {
  readonly groups: readonly { readonly group: SwitchGroup; readonly rows: readonly KillSwitchRow[] }[];
  /** Known switches the API did not report: listed, never dropped, and treated as Blocked (fail closed). */
  readonly notReported: readonly { readonly key: string; readonly label: string }[];
  readonly blockedCount: number;
  readonly allowedCount: number;
}

export function killSwitchBoard(items: readonly FlagWire[], locale: Locale): KillSwitchBoard {
  const kills = items.filter((i) => i.kind === "kill_switch");
  const rows = kills.map((f) => toRow(f, locale));
  const reported = new Set(kills.map((k) => k.key));
  const notReported = ALL_SWITCH_KEYS.filter((k) => !reported.has(k)).map((key) => ({ key, label: switchLabel(key, locale) }));
  const groups = SWITCH_GROUPS.map((group) => ({
    group,
    rows: rows.filter((r) => r.group === group).sort((a, b) => a.key.localeCompare(b.key)),
  })).filter((g) => g.rows.length > 0);
  return {
    groups,
    notReported,
    blockedCount: rows.filter((r) => r.state === "blocked").length,
    allowedCount: rows.filter((r) => r.state === "allowed").length,
  };
}

/** Sentence for the change dialog: states the resulting state in words, with the capability name. */
export function changeSentence(row: KillSwitchRow, locale: Locale): string {
  const to = row.nextState === "allowed" ? (locale === "ar" ? "مسموح" : "Allowed") : (locale === "ar" ? "محظور" : "Blocked");
  const base = locale === "ar" ? `بعد هذا التغيير سيصبح «${row.label}» ${to}.` : `After this change, ${row.label} will be ${to}.`;
  if (row.nextState === "blocked" && row.blockedMeans !== null) return `${base} ${locale === "ar" ? "الأثر:" : "Effect:"} ${row.blockedMeans}.`;
  return base;
}

/** Looks up one capability's state for other screens (gift cards, drops, ...). Missing means Blocked (fail closed). */
export function stateFor(items: readonly FlagWire[], key: string): { readonly state: SwitchState; readonly reported: boolean } {
  const f = items.find((i) => i.key === key);
  return f === undefined ? { state: "blocked", reported: false } : { state: stateOf(f.enabled), reported: true };
}
