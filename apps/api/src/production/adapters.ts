import type { FlagClient } from "../../../../packages/feature-flags/src/index";
import { FLAG_REGISTRY, type FlagKey } from "../../../../packages/feature-flags/src/index";
import type { FlagAdminBackend } from "../modules/admin";
import { ProviderNotConfiguredError } from "./unconfigured";

/**
 * Webhook source-IP allow list for deployments with no PSP configured: nothing is allowed. This is
 * a real fail-closed policy, not a stand-in, so webhooks are refused until an operator supplies IPs.
 */
export class DenyAllWebhookIps {
  async isAllowed(): Promise<boolean> {
    return false;
  }
}

/** Counters in process memory. Metrics must never break a checkout, so this sink does not throw. */
export class ProcessMetrics {
  private readonly counts = new Map<string, number>();
  increment(name: string, labels?: Readonly<Record<string, string>>): void {
    const key = labels === undefined ? name : `${name}{${Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(",")}}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
  snapshot(): ReadonlyMap<string, number> {
    return this.counts;
  }
}

type FlagView = Awaited<ReturnType<FlagAdminBackend["list"]>>[number];

/**
 * Admin flag console over the registry. Reads report the evaluated state (blocked by default);
 * writes need a flag provider, which is Unconfigured, so they fail with provider_not_configured.
 */
export class FlagBackendOverRegistry implements FlagAdminBackend {
  constructor(private readonly client: FlagClient) {}

  private async view(key: string, description: string, kind: FlagView["kind"]): Promise<FlagView> {
    const d = await this.client.evaluate(key);
    return { key, kind, description, enabled: d.enabled, isDefault: d.source !== "provider" };
  }

  async list(): Promise<readonly FlagView[]> {
    return Promise.all(FLAG_REGISTRY.map((f) => this.view(f.key, f.description, f.key.startsWith("release.") ? "release" : "kill_switch")));
  }

  async get(key: string): Promise<FlagView | null> {
    const f = FLAG_REGISTRY.find((x) => x.key === (key as FlagKey));
    return f === undefined ? null : this.view(f.key, f.description, f.key.startsWith("release.") ? "release" : "kill_switch");
  }

  async set(): Promise<FlagView | null> {
    throw new ProviderNotConfiguredError("flags.provider", "set");
  }
}
