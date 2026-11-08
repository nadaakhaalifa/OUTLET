import { z } from "zod";

export const PrincipalKind = z.enum(["anonymous", "shopper", "seller_staff", "admin", "system"]);
export type PrincipalKind = z.infer<typeof PrincipalKind>;

export const Principal = z.object({
  kind: PrincipalKind,
  userId: z.string().min(1).optional(),
  marketId: z.string().min(1),
  /** Seller staff may belong to several stores. */
  storeIds: z.array(z.string().min(1)).optional(),
  roles: z.array(z.string()),
  scopes: z.array(z.string()),
  /** super_admin grants apply only when this is explicitly true (break-glass session, dual approval). */
  breakGlass: z.boolean().optional(),
});
export type Principal = z.infer<typeof Principal>;

export const Resource = z.object({
  type: z.string().min(1),
  id: z.string().min(1).optional(),
  ownerUserId: z.string().min(1).optional(),
  storeId: z.string().min(1).optional(),
  marketId: z.string().min(1),
});
export type Resource = z.infer<typeof Resource>;

/** `resource.verb`, for example `order.read`, `payout.approve`. */
export type Action = string;

export type Decision =
  | { readonly effect: "allow" }
  | { readonly effect: "deny"; readonly reason: "not_found" | "forbidden" };
