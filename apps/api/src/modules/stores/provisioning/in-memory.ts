import type {
  ApprovedPayload,
  BrandNotifierPort,
  BrandTemplateKey,
  ChecklistItemCode,
  ConflictQueuePort,
  EtaStatus,
  InboxRunner,
  ProvisioningApplicationPort,
  ProvisioningEventsPort,
  ProvisioningFailureCode,
  SellerMembershipsPort,
  StoreOnboardingPort,
} from "./domain";

export class InMemoryInboxRunner implements InboxRunner {
  private readonly seen = new Set<string>();
  async runOnce<T>(consumer: string, messageId: string, fn: () => Promise<T>) {
    const key = `${consumer}:${messageId}`;
    if (this.seen.has(key)) return { kind: "duplicate" as const };
    const value = await fn();
    this.seen.add(key);
    return { kind: "done" as const, value };
  }
}

export class InMemorySellerMemberships implements SellerMembershipsPort {
  /** storeId -> owner user ids */
  readonly owners = new Map<string, Set<string>>();
  async grantOwner(i: { sellerUserId: string; storeId: string }): Promise<void> {
    const set = this.owners.get(i.storeId) ?? new Set<string>();
    set.add(i.sellerUserId);
    this.owners.set(i.storeId, set);
  }
  storesOwnedBy(userId: string): string[] {
    return [...this.owners].filter(([, o]) => o.has(userId)).map(([s]) => s);
  }
}

export class InMemoryStoreOnboarding implements StoreOnboardingPort {
  readonly checklists = new Map<string, readonly ChecklistItemCode[]>();
  readonly eta = new Map<string, EtaStatus>();
  async seedChecklist(storeId: string, items: readonly ChecklistItemCode[]): Promise<void> {
    if (!this.checklists.has(storeId)) this.checklists.set(storeId, items);
  }
  async setEtaRegistration(storeId: string, status: EtaStatus): Promise<void> {
    this.eta.set(storeId, status);
  }
}

export class InMemoryProvisioningApplications implements ProvisioningApplicationPort {
  readonly payloads = new Map<string, ApprovedPayload>();
  readonly provisioned = new Map<string, string>();
  readonly failed = new Map<string, ProvisioningFailureCode>();
  async payloadFor(applicationId: string): Promise<ApprovedPayload | null> {
    return this.payloads.get(applicationId) ?? null;
  }
  async markProvisioned(applicationId: string, storeId: string): Promise<void> {
    this.provisioned.set(applicationId, storeId);
    this.failed.delete(applicationId);
  }
  async markProvisioningFailed(applicationId: string, code: ProvisioningFailureCode): Promise<void> {
    this.failed.set(applicationId, code);
  }
  async listFailed(limit: number): Promise<readonly string[]> {
    return [...this.failed.keys()].slice(0, limit);
  }
}

export class InMemoryConflictQueue implements ConflictQueuePort {
  readonly entries: { applicationId: string; reason: string; conflictingStoreId: string }[] = [];
  async enqueue(c: { applicationId: string; reason: "store_name_conflict"; conflictingStoreId: string }): Promise<void> {
    if (!this.entries.some((e) => e.applicationId === c.applicationId)) this.entries.push(c);
  }
}

export class InMemoryProvisioningEvents implements ProvisioningEventsPort {
  readonly published: { type: string; key: string; payload: Readonly<Record<string, string | boolean | null>> }[] = [];
  async publish(e: { type: "store.provisioned"; key: string; payload: Readonly<Record<string, string | boolean | null>> }): Promise<void> {
    if (!this.published.some((p) => p.type === e.type && p.key === e.key)) this.published.push(e);
  }
}

export class RecordingBrandNotifier implements BrandNotifierPort {
  readonly sent: { userId: string; templateKey: BrandTemplateKey; ref: string; brandName: string; deepLink: string }[] = [];
  failNext = false;
  async notify(i: { userId: string; templateKey: BrandTemplateKey; ref: string; brandName: string; deepLink: string }): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("notifier down");
    }
    // Same (user, template, ref) is one notification, mirroring SendNotification's dedupe.
    if (!this.sent.some((s) => s.userId === i.userId && s.templateKey === i.templateKey && s.ref === i.ref)) this.sent.push(i);
  }
}
