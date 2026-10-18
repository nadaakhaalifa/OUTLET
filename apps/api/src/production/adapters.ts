import type { FlagClient } from "../../../../packages/feature-flags/src/index";
import { FLAG_REGISTRY, type FlagKey } from "../../../../packages/feature-flags/src/index";
import type { AdminStore, FlagAdminBackend } from "../modules/admin";
import type { VoidApprovalPort } from "../modules/gift-cards";
import { QueueUnavailableError, type QueuePort } from "../modules/waiting-room";
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

type ApprovalRecord = NonNullable<Awaited<ReturnType<AdminStore["getApproval"]>>>;

/**
 * Gift-card void approvals over the admin module's approvals store. `find` reads the persisted dual
 * approval; the use case checks it covers exactly this card, amount and time (`approvalCovers`).
 * `consume` is single-use per process; across processes replay is harmless because the approval is bound
 * to one card id and a voided card cannot be voided again. A durable consumption table is a
 * follow-up (needs a migration and an inventory entry; see docs/plan/api-client-gap.md).
 */
export class AdminStoreVoidApprovals implements VoidApprovalPort {
  private readonly consumed = new Set<string>();
  constructor(private readonly store: Pick<AdminStore, "getApproval">) {}
  async find(approvalId: string): Promise<ApprovalRecord | null> {
    return this.store.getApproval(approvalId);
  }
  async consume(approvalId: string): Promise<boolean> {
    if (this.consumed.has(approvalId)) return false;
    this.consumed.add(approvalId);
    return true;
  }
}

/**
 * Ops counters must report "unmeasured" (null), never throw, when the queue backend is not configured.
 * Every call delegates; only an Unconfigured provider error on `size` is mapped to QueueUnavailableError.
 */
export class UnmeasuredWhenUnavailableQueue implements QueuePort {
  constructor(private readonly q: QueuePort) {}
  join: QueuePort["join"] = (...a) => this.q.join(...a);
  heartbeat: QueuePort["heartbeat"] = (...a) => this.q.heartbeat(...a);
  peek: QueuePort["peek"] = (...a) => this.q.peek(...a);
  reject: QueuePort["reject"] = (...a) => this.q.reject(...a);
  admit: QueuePort["admit"] = (...a) => this.q.admit(...a);
  expire: QueuePort["expire"] = (...a) => this.q.expire(...a);
  finish: QueuePort["finish"] = (...a) => this.q.finish(...a);
  async size(dropId: string): Promise<number> {
    try {
      return await this.q.size(dropId);
    } catch (e) {
      if (e instanceof ProviderNotConfiguredError) throw new QueueUnavailableError();
      throw e;
    }
  }
}
