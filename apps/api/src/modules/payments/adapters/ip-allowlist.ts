import type { WebhookIpAllowListPort } from "../domain/ports";

/**
 * Exact-match IP allow-list per provider. CIDR ranges are not interpreted here: PSP ranges are not
 * known (VR-PAY-09), so an empty list for a provider means "deny all" in production. Tests and the
 * in-memory dev profile use `AllowAllIps`, which is never wired outside `in-memory-dev`.
 */
export class StaticIpAllowList implements WebhookIpAllowListPort {
  constructor(private readonly byProvider: Readonly<Record<string, readonly string[]>>) {}
  async isAllowed(provider: string, ip: string | undefined): Promise<boolean> {
    if (ip === undefined) return false;
    const norm = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
    return (this.byProvider[provider] ?? []).includes(norm);
  }
}

export class AllowAllIps implements WebhookIpAllowListPort {
  async isAllowed(): Promise<boolean> {
    return true;
  }
}
