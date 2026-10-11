import type { AdminMe } from "../api/schemas";
import type { MessageKey } from "../i18n";

export type PostureLevel = "ok" | "device_untrusted" | "ip_not_allowlisted" | "unknown";

export interface Posture {
  readonly level: PostureLevel;
  /** Controls that change money, access or flags are disabled when false. The API still enforces its own rules. */
  readonly sensitiveWritesEnabled: boolean;
  readonly bannerKey: MessageKey | null;
}

/** Spec 23: "IP allow-list for Finance and Super-admin", device posture for everyone. Unknown fails closed. */
export function evaluatePosture(me: AdminMe | null): Posture {
  if (me === null) return { level: "unknown", sensitiveWritesEnabled: false, bannerKey: "posture.unknown" };
  const ipRequired = me.roles.includes("finance") || me.standing_roles.includes("finance") || me.standing_roles.includes("super_admin") || me.roles.includes("super_admin");
  if (!me.posture.device_trusted) return { level: "device_untrusted", sensitiveWritesEnabled: false, bannerKey: "posture.deviceUntrusted" };
  if (ipRequired && !me.posture.ip_allowlisted) return { level: "ip_not_allowlisted", sensitiveWritesEnabled: false, bannerKey: "posture.ipNotAllowlisted" };
  if (me.assurance !== "passkey") return { level: "device_untrusted", sensitiveWritesEnabled: false, bannerKey: "posture.notPasskey" };
  return { level: "ok", sensitiveWritesEnabled: true, bannerKey: null };
}
