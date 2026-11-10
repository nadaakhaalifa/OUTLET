import { ADMIN_POLICY } from "@outlet/policy";
import { z } from "zod";
import { isRole, type AdminRole } from "../lib/roles";


/** The AdminSession body returned by POST /admin/auth/passkey/verify. */
export const AdminSessionBody = z.object({
  staff_id: z.uuid(),
  market_id: z.string().min(2),
  roles: z.array(z.string()),
  amr: z.array(z.string()),
  expires_at: z.iso.datetime({ offset: true }),
});

export interface Profile {
  readonly staffId: string;
  readonly market: string;
  readonly roles: readonly AdminRole[];
  readonly amr: readonly string[];
  readonly expiresAt: string;
  /** super_admin applies only in a break-glass session (policy.authorize); the shell shows a banner whenever it is live. */
  readonly breakGlass: boolean;
}

export function profileFromSession(body: z.infer<typeof AdminSessionBody>): Profile {
  const roles = body.roles.filter(isRole);
  return { staffId: body.staff_id, market: body.market_id, roles, amr: body.amr, expiresAt: body.expires_at, breakGlass: roles.includes("super_admin") };
}

export const serializeProfile = (p: Profile): string => JSON.stringify(p);

const ProfileCookie = z.object({
  staffId: z.uuid(),
  market: z.string(),
  roles: z.array(z.string()),
  amr: z.array(z.string()),
  expiresAt: z.string(),
  breakGlass: z.boolean(),
});

/** Null for a missing, malformed or expired cookie. */
export function parseProfile(raw: string | undefined, now: Date): Profile | null {
  if (raw === undefined || raw === "") return null;
  try {
    const p = ProfileCookie.parse(JSON.parse(raw));
    if (Date.parse(p.expiresAt) <= now.getTime()) return null;
    return { ...p, roles: p.roles.filter(isRole) };
  } catch {
    return null;
  }
}

/** Does the live role set grant `action`? super_admin counts only while break-glass is on, exactly like @outlet/policy. */
export function can(profile: Profile, action: string): boolean {
  return profile.roles.some((role) => (role !== "super_admin" || profile.breakGlass) && ADMIN_POLICY[role].includes(action));
}

export type SectionId = "kyc" | "price" | "recon" | "dpo" | "audit" | "access" | "attention" | "dlq" | "refunds" | "payouts" | "returns" | "disputes";

/** Which console sections a role set may open (display only; the API enforces the same rules). */
export function visibleSections(profile: Profile): readonly SectionId[] {
  const out: SectionId[] = [];
  if (can(profile, "seller_kyc.review")) out.push("kyc");
  if (can(profile, "listing.read") && (profile.roles.includes("ops") || profile.roles.includes("trust_safety"))) out.push("price");
  if (can(profile, "ledger.read")) out.push("recon");
  if (can(profile, "breach.manage")) out.push("dpo");
  if (can(profile, "audit.read")) out.push("audit");
  if (can(profile, "attention.read")) out.push("attention");
  if (can(profile, "dlq.manage")) out.push("dlq");
  if (can(profile, "refund.approve")) out.push("refunds");
  if (can(profile, "payout.read")) out.push("payouts");
  if (can(profile, "return.read")) out.push("returns");
  if (can(profile, "dispute.decide")) out.push("disputes");
  out.push("access");
  return out;
}
