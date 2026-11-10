import type { ConsentPurpose } from "@outlet/privacy";
import { DEFAULT_QUIET_HOURS, nextAllowedTime, isQuietHour } from "./cairo-time.js";
import type { QuietHours } from "./cairo-time.js";
import { MARKETING_PURPOSE } from "./types.js";
import type { Category, Channel, SuppressionReason } from "./types.js";

export interface FrequencyCaps {
  /** Maximum marketing sends per rolling 24 h, per channel in `channels`. */
  readonly perDay: number;
  /** Maximum marketing sends per rolling 7 days. */
  readonly perWeek: number;
  /** Channels the caps apply to (master prompt 24: push). */
  readonly channels: readonly Channel[];
}
export const DEFAULT_CAPS: FrequencyCaps = { perDay: 1, perWeek: 3, channels: ["push"] };

export interface DecideInput {
  readonly category: Category;
  readonly channel: Channel;
  /** Consent purposes the user currently has granted (latest decision wins). */
  readonly grantedConsents: ReadonlySet<ConsentPurpose>;
  /** The user's stored preference for this channel and category; undefined = never set (default on). */
  readonly preferenceEnabled: boolean | undefined;
  /** Instant of the decision; quiet hours are evaluated in Africa/Cairo. */
  readonly now: Date;
  /** Instants of marketing messages already SENT on this channel. */
  readonly recentSends: readonly Date[];
  /** Kill switch for the channel. */
  readonly killed: boolean;
  readonly caps?: FrequencyCaps;
  readonly quietHours?: QuietHours;
}

export type Decision =
  | { readonly kind: "send" }
  | { readonly kind: "suppress"; readonly reason: SuppressionReason }
  | { readonly kind: "defer"; readonly until: Date };

const DAY_MS = 86_400_000;

/**
 * Pure send decision. Order: kill switch, user preference, marketing consent, frequency cap, quiet hours.
 * Transactional messages ignore consent, caps and quiet hours (only a kill switch or the user's own mute stops them).
 * Marketing is NEVER sent without the channel's consent purpose; SMS has no marketing purpose and is always suppressed.
 */
export const decide = (i: DecideInput): Decision => {
  if (i.killed) return { kind: "suppress", reason: "killed" };
  if (i.preferenceEnabled === false) return { kind: "suppress", reason: "unsubscribed" };
  if (i.category === "transactional") return { kind: "send" };

  const purpose = MARKETING_PURPOSE[i.channel];
  if (purpose === null ? i.channel === "sms" : !i.grantedConsents.has(purpose)) return { kind: "suppress", reason: "consent" };

  const caps = i.caps ?? DEFAULT_CAPS;
  if (caps.channels.includes(i.channel)) {
    const t = i.now.getTime();
    const inWindow = (ms: number): number => i.recentSends.filter((s) => s.getTime() > t - ms && s.getTime() <= t).length;
    if (inWindow(DAY_MS) >= caps.perDay || inWindow(7 * DAY_MS) >= caps.perWeek) return { kind: "suppress", reason: "cap" };
  }

  const q = i.quietHours ?? DEFAULT_QUIET_HOURS;
  if (isQuietHour(i.now, q)) return { kind: "defer", until: nextAllowedTime(i.now, q) };
  return { kind: "send" };
};
