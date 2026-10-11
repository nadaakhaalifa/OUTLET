import type { DropLimits } from "./types";

export type LimitVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "user_limit" | "device_limit" | "bad_quantity"; readonly remaining: number };

/** Per-user and per-device purchase allowance per SKU (spec 16). Quantities are units. */
export function checkPurchaseLimit(
  limits: DropLimits,
  bought: { readonly byUser: number; readonly byDevice: number },
  qty: number,
): LimitVerdict {
  if (!Number.isInteger(qty) || qty < 1) return { ok: false, code: "bad_quantity", remaining: 0 };
  const userLeft = Math.max(0, limits.perUser - bought.byUser);
  const deviceLeft = Math.max(0, limits.perDevice - bought.byDevice);
  if (qty > userLeft) return { ok: false, code: "user_limit", remaining: userLeft };
  if (qty > deviceLeft) return { ok: false, code: "device_limit", remaining: deviceLeft };
  return { ok: true };
}
