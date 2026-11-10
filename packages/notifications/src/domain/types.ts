import type { ConsentPurpose } from "@outlet/privacy";

export const CHANNELS = ["push", "in_app", "whatsapp", "sms", "email"] as const;
export type Channel = (typeof CHANNELS)[number];

export const CATEGORIES = ["transactional", "marketing"] as const;
export type Category = (typeof CATEGORIES)[number];

export const SUPPRESSION_REASONS = ["consent", "quiet_hours", "cap", "killed", "unsubscribed"] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/**
 * Master prompt B1: marketing needs the consent purpose of the channel. SMS has no marketing purpose, so marketing SMS is never
 * sent. in_app is the on-platform inbox: no external contact, so it needs no consent (preferences still apply).
 */
export const MARKETING_PURPOSE: Readonly<Record<Channel, ConsentPurpose | null>> = {
  push: "marketing_push",
  whatsapp: "marketing_whatsapp",
  email: "marketing_email",
  sms: null,
  in_app: null,
};
