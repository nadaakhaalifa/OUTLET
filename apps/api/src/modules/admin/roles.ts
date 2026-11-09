import { ADMIN_POLICY, ADMIN_ROLES, SELLER_POLICY, SELLER_ROLES } from "@outlet/policy";
import { decodeCursor, encodeCursor } from "../../platform/cursor.js";
import { Problems } from "../../platform/problem.js";
import type { RoleDto, RolePage, RolesQuery } from "./dto.js";

const DESCRIPTIONS: Readonly<Record<string, string>> = {
  ops: "Operations: seller KYC, store status, returns, approvals",
  finance: "Finance: ledger, reconciliation, payouts, refunds, tax, money kill switches",
  trust_safety: "Trust and safety: store status, takedowns, disputes, seller KYC",
  support: "Support: orders, returns, customer messages, user lookup",
  marketing: "Marketing: promotions and plan pricing",
  dpo: "Data protection officer: privacy requests, exports, breaches",
  security: "Security: audit log, role grants, sessions, kill switches, elevations",
  super_admin: "Break-glass only: every use needs a second approver",
  owner: "Seller owner: store, team, listings, orders, payouts",
  manager: "Seller manager: listings, orders, returns, promotions",
  catalog: "Seller catalog: listings and promotions",
  warehouse: "Seller warehouse: fulfillment and return inspection",
  finance_seller: "Seller finance: orders, payouts, statements",
  support_seller: "Seller support: orders, returns, customer messages",
};

/** Static catalogue straight from @outlet/policy (the single source of truth for who may do what): admin roles, then seller roles. Seller finance/support share a code with the admin roles, so keys are scoped. */
const CATALOGUE: readonly RoleDto[] = [
  ...ADMIN_ROLES.map((code): RoleDto => ({ code, scope: "admin", description: DESCRIPTIONS[code] ?? code, permissions: [...new Set(ADMIN_POLICY[code])].sort() })),
  ...SELLER_ROLES.map((code): RoleDto => ({ code, scope: "seller", description: DESCRIPTIONS[code === "finance" || code === "support" ? `${code}_seller` : code] ?? code, permissions: [...new Set(SELLER_POLICY[code])].sort() })),
];

/** Keyset page over the catalogue (cursor = scope|code of the last item). */
export const rolePage = (q: RolesQuery): RolePage => {
  let start = 0;
  if (q.cursor !== undefined) {
    const [scope, code] = decodeCursor(q.cursor, 2);
    const at = CATALOGUE.findIndex((r) => r.scope === scope && r.code === code);
    if (at < 0) throw Problems.badRequest("cursor-invalid");
    start = at + 1;
  }
  const items = CATALOGUE.slice(start, start + q.limit);
  const last = items[items.length - 1];
  return { items: [...items], next_cursor: start + q.limit < CATALOGUE.length && last !== undefined ? encodeCursor(last.scope, last.code) : null };
};
