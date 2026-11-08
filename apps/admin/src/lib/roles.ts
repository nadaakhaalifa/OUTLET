export const ADMIN_ROLES = ["ops", "finance", "trust_safety", "support", "marketing", "dpo", "security", "super_admin"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];
export const isRole = (r: string): r is AdminRole => (ADMIN_ROLES as readonly string[]).includes(r);
