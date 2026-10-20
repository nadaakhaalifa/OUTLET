import type { ApplicationStatus, Checklist, ChecklistCode, SellerRole } from "../api/schemas-onboarding";
import type { MessageKey } from "../i18n";

/** First-login checklist: progress, ordering, and where to go next. */

interface Meta {
  readonly titleKey: MessageKey;
  readonly bodyKey: MessageKey;
  readonly href: string;
  readonly roles: readonly SellerRole[];
}

const META: Readonly<Record<ChecklistCode, Meta>> = {
  complete_store_profile: { titleKey: "ob.check.profile.title", bodyKey: "ob.check.profile.body", href: "/settings/profile", roles: ["owner", "manager"] },
  add_english_store_name: { titleKey: "ob.check.enname.title", bodyKey: "ob.check.enname.body", href: "/settings/profile", roles: ["owner", "manager"] },
  add_payout_iban: { titleKey: "ob.check.payout.title", bodyKey: "ob.check.payout.body", href: "/settings/payout", roles: ["owner", "finance"] },
  set_shipping_origin: { titleKey: "ob.check.shipping.title", bodyKey: "ob.check.shipping.body", href: "/settings/shipping", roles: ["owner", "manager"] },
  add_first_product: { titleKey: "ob.check.product.title", bodyKey: "ob.check.product.body", href: "/catalog/new", roles: ["owner", "manager", "catalog"] },
  enrol_eta_receipts: { titleKey: "ob.check.eta.title", bodyKey: "ob.check.eta.body", href: "/settings/eta", roles: ["owner", "manager"] },
  invite_team: { titleKey: "ob.check.team.title", bodyKey: "ob.check.team.body", href: "/settings/team", roles: ["owner"] },
};

const ORDER: readonly ChecklistCode[] = [
  "complete_store_profile", "add_english_store_name", "add_payout_iban", "set_shipping_origin", "add_first_product", "enrol_eta_receipts", "invite_team",
];

export interface ChecklistRow {
  readonly code: ChecklistCode;
  readonly titleKey: MessageKey;
  readonly bodyKey: MessageKey;
  readonly href: string;
  readonly done: boolean;
  readonly requiredForPublish: boolean;
  /** False when the signed-in role cannot perform it (the owner is shown who can). */
  readonly actionable: boolean;
}

export interface ChecklistVM {
  readonly rows: readonly ChecklistRow[];
  readonly doneCount: number;
  readonly total: number;
  readonly percent: number;
  readonly requiredRemaining: number;
  readonly readyToPublish: boolean;
  readonly next: ChecklistRow | null;
}

export function checklistVM(c: Checklist, role: SellerRole | null): ChecklistVM {
  const byCode = new Map(c.items.map((i) => [i.code, i]));
  const rows: ChecklistRow[] = [];
  for (const code of ORDER) {
    const i = byCode.get(code);
    if (i === undefined) continue;
    const m = META[code];
    rows.push({
      code, titleKey: m.titleKey, bodyKey: m.bodyKey, href: m.href, done: i.done, requiredForPublish: i.required_for_publish,
      actionable: role === null || m.roles.includes(role),
    });
  }
  const done = rows.filter((r) => r.done).length;
  const required = rows.filter((r) => r.requiredForPublish && !r.done);
  const next = rows.find((r) => !r.done && r.requiredForPublish && r.actionable) ?? rows.find((r) => !r.done && r.actionable) ?? null;
  return {
    rows,
    doneCount: done,
    total: rows.length,
    percent: rows.length === 0 ? 0 : Math.floor((done * 100) / rows.length),
    requiredRemaining: required.length,
    readyToPublish: required.length === 0,
    next,
  };
}

/** Where to send someone right after sign-in. Pure so the routing rule is tested. */
export function routeAfterSignIn(input: {
  readonly memberships: readonly { readonly store_id: string; readonly role: SellerRole }[];
  readonly applicationStatuses: readonly ApplicationStatus[];
  readonly applicationIds: readonly string[];
  readonly checklist: Checklist | null;
}): string {
  if (input.memberships.length === 0) {
    const open = input.applicationStatuses.findIndex((s) => s !== "WITHDRAWN" && s !== "REJECTED");
    const id = input.applicationIds[open >= 0 ? open : 0];
    if (input.applicationIds.length === 0 || id === undefined) return "/apply";
    return `/apply/${encodeURIComponent(id)}`;
  }
  if (input.checklist !== null && input.checklist.items.some((i) => i.required_for_publish && !i.done)) return "/onboarding";
  return "/dashboard";
}
