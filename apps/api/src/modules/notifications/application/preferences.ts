import { formatHhmm } from "../domain/cairo-time";
import type { Clock, ConsentPort, PreferenceRepository, SuppressionRepository } from "../domain/ports";
import {
  DEFAULT_QUIET_HOURS,
  FIXED_TYPES,
  MARKETING_PURPOSE,
  SWITCHABLE_TYPES,
  isSwitchable,
  type ExternalChannel,
  type QuietHours,
} from "../domain/types";

export interface PreferencesView {
  readonly pushMarketing: boolean;
  readonly whatsappMarketing: boolean;
  readonly smsMarketing: false;
  readonly emailMarketing: boolean;
  readonly types: readonly { readonly type: string; readonly enabled: boolean }[];
  readonly quietHours: { readonly from: string; readonly to: string; readonly timezone: "Africa/Cairo" };
}

export interface PreferencePatch {
  readonly pushMarketing?: boolean;
  readonly whatsappMarketing?: boolean;
  readonly smsMarketing?: boolean;
  readonly emailMarketing?: boolean;
  readonly types?: readonly { readonly type: string; readonly enabled: boolean }[];
}

export type PreferenceRule =
  | "consent_required"
  | "channel_not_supported"
  | "type_not_switchable"
  | "unknown_type";

export type UpdatePreferencesResult =
  | { readonly kind: "updated"; readonly view: PreferencesView }
  | { readonly kind: "precondition_failed" }
  | { readonly kind: "rule"; readonly code: PreferenceRule };

const OVERRIDE_CHANNELS = ["push", "whatsapp", "email", "in_app"] as const;
const FLAGS = [
  ["pushMarketing", "push"],
  ["whatsappMarketing", "whatsapp"],
  ["emailMarketing", "email"],
] as const satisfies readonly (readonly [keyof PreferencePatch, ExternalChannel])[];

export class NotificationPreferences {
  constructor(
    private readonly prefs: PreferenceRepository,
    private readonly suppressions: SuppressionRepository,
    private readonly consent: ConsentPort,
    private readonly clock: Clock,
    private readonly quiet: QuietHours = DEFAULT_QUIET_HOURS,
  ) {}

  async get(userId: string): Promise<PreferencesView> {
    const stored = await this.prefs.all(userId);
    const flag = async (channel: "push" | "whatsapp" | "email"): Promise<boolean> => {
      const purpose = MARKETING_PURPOSE[channel];
      if (purpose === undefined) return false;
      const [granted, active] = await Promise.all([
        this.consent.isGranted(userId, purpose),
        this.suppressions.active(userId, channel),
      ]);
      return granted && !active.has("UNSUBSCRIBED");
    };
    const [push, whatsapp, email] = await Promise.all([flag("push"), flag("whatsapp"), flag("email")]);
    const types: { type: string; enabled: boolean }[] = SWITCHABLE_TYPES.map((t) => ({ type: t, enabled: stored.get(t) ?? true }));
    for (const t of SWITCHABLE_TYPES) {
      for (const c of OVERRIDE_CHANNELS) {
        const v = stored.get(`${t}.${c}`);
        if (v !== undefined) types.push({ type: `${t}.${c}`, enabled: v });
      }
    }
    return {
      pushMarketing: push,
      whatsappMarketing: whatsapp,
      smsMarketing: false,
      emailMarketing: email,
      types,
      quietHours: { from: formatHhmm(this.quiet.fromMin), to: formatHhmm(this.quiet.toMin), timezone: "Africa/Cairo" },
    };
  }

  async update(
    userId: string,
    patch: PreferencePatch,
    precondition: (current: PreferencesView) => boolean,
  ): Promise<UpdatePreferencesResult> {
    const current = await this.get(userId);
    if (!precondition(current)) return { kind: "precondition_failed" };
    const now = this.clock.nowMs();

    // Validate everything before applying anything (all or nothing).
    if (patch.smsMarketing === true) return { kind: "rule", code: "channel_not_supported" };
    const typeEntries = new Map<string, boolean>();
    for (const entry of patch.types ?? []) {
      const [base, channel, ...rest] = entry.type.split(".");
      if (base === undefined || rest.length > 0) return { kind: "rule", code: "unknown_type" };
      if ((FIXED_TYPES as readonly string[]).includes(base)) return { kind: "rule", code: "type_not_switchable" };
      if (!isSwitchable(base)) return { kind: "rule", code: "unknown_type" };
      if (channel !== undefined && !(OVERRIDE_CHANNELS as readonly string[]).includes(channel)) {
        return { kind: "rule", code: channel === "sms" ? "channel_not_supported" : "unknown_type" };
      }
      typeEntries.set(entry.type, entry.enabled);
    }
    for (const [key, channel] of FLAGS) {
      if (patch[key] !== true) continue;
      const purpose = MARKETING_PURPOSE[channel];
      if (purpose === undefined || !(await this.consent.isGranted(userId, purpose))) {
        return { kind: "rule", code: "consent_required" };
      }
    }

    for (const [key, channel] of FLAGS) {
      const value = patch[key];
      if (value === undefined) continue;
      const purpose = MARKETING_PURPOSE[channel];
      if (purpose === undefined) continue;
      if (value) {
        await this.suppressions.remove(userId, channel, "UNSUBSCRIBED");
      } else {
        // One tap, immediate: withdraw the consent and suppress the channel for marketing.
        await this.consent.withdraw(userId, purpose);
        await this.suppressions.add(userId, channel, "UNSUBSCRIBED", now);
      }
    }
    if (typeEntries.size > 0) await this.prefs.setMany(userId, typeEntries, now);
    return { kind: "updated", view: await this.get(userId) };
  }
}
