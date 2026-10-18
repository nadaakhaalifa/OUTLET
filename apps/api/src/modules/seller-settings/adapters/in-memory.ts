import { sellerSettings as ss } from "@outlet/domain";
import type {
  EtaRecord,
  InviteRecord,
  NotificationPrefs,
  PayoutAccountRecord,
  ProfileRecord,
  SettingsArea,
  SettingsEvent,
  SettingsRepository,
  ShippingRecord,
  UploadRecord,
} from "../domain/ports";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

export class InMemorySettingsRepository implements SettingsRepository {
  private readonly profiles = new Map<string, ProfileRecord>();
  private readonly uploads = new Map<string, UploadRecord>();
  private accounts: PayoutAccountRecord[] = [];
  private readonly shipping = new Map<string, ShippingRecord>();
  private readonly prefs = new Map<string, NotificationPrefs>();
  private invites: InviteRecord[] = [];
  private readonly eta = new Map<string, EtaRecord>();
  private events: SettingsEvent[] = [];

  async getProfile(storeId: string) {
    return this.profiles.get(storeId) ?? null;
  }
  async saveProfile(rec: ProfileRecord, expectedVersion: number | null) {
    const cur = this.profiles.get(rec.storeId);
    if (expectedVersion === null ? cur !== undefined : cur?.version !== expectedVersion) return false;
    this.profiles.set(rec.storeId, rec);
    return true;
  }

  async createUpload(u: UploadRecord) {
    this.uploads.set(`${u.storeId}:${u.id}`, u);
  }
  async getUpload(storeId: string, id: string) {
    return this.uploads.get(`${storeId}:${id}`) ?? null;
  }
  async markUpload(
    storeId: string,
    id: string,
    patch: { status: "confirmed" | "rejected"; rejectCode?: string; width?: number; height?: number; atMs: number },
  ) {
    const u = this.uploads.get(`${storeId}:${id}`);
    if (u === undefined) return;
    this.uploads.set(`${storeId}:${id}`, {
      ...u,
      status: patch.status,
      rejectCode: patch.rejectCode ?? null,
      width: patch.width ?? null,
      height: patch.height ?? null,
    });
  }

  async activeAccount(storeId: string) {
    return this.accounts.find((a) => a.storeId === storeId && a.status === "ACTIVE") ?? null;
  }
  async replaceAccount(next: PayoutAccountRecord) {
    this.accounts = this.accounts.map((a) => (a.storeId === next.storeId && a.status === "ACTIVE" ? { ...a, status: "SUPERSEDED" as const } : a));
    this.accounts.push(next);
  }

  async getShipping(storeId: string) {
    return this.shipping.get(storeId) ?? null;
  }
  async saveShipping(rec: ShippingRecord, expectedVersion: number | null) {
    const cur = this.shipping.get(rec.storeId);
    if (expectedVersion === null ? cur !== undefined : cur?.version !== expectedVersion) return false;
    this.shipping.set(rec.storeId, rec);
    return true;
  }

  async getPrefs(storeId: string) {
    return this.prefs.get(storeId) ?? ss.defaultPrefs();
  }
  async savePrefs(storeId: string, prefs: NotificationPrefs) {
    this.prefs.set(storeId, prefs);
  }

  async insertInvite(inv: InviteRecord) {
    const dup = this.invites.some((i) => i.storeId === inv.storeId && i.status === "PENDING" && hex(i.phoneBlind) === hex(inv.phoneBlind));
    if (dup) return "duplicate_pending" as const;
    this.invites.push(inv);
    return "ok" as const;
  }
  async getInvite(storeId: string, id: string) {
    return this.invites.find((i) => i.storeId === storeId && i.id === id) ?? null;
  }
  async getInviteByTokenHash(tokenHash: string) {
    return this.invites.find((i) => i.tokenHash === tokenHash) ?? null;
  }
  async listInvites(storeId: string) {
    return this.invites.filter((i) => i.storeId === storeId).sort((a, b) => b.createdAtMs - a.createdAtMs);
  }
  async countPendingInvites(storeId: string, nowMs: number) {
    return this.invites.filter((i) => i.storeId === storeId && i.status === "PENDING" && i.expiresAtMs > nowMs).length;
  }
  async closeInvite(id: string, status: Exclude<ss.InviteState, "PENDING">, by: string | null, atMs: number) {
    const i = this.invites.findIndex((x) => x.id === id && x.status === "PENDING");
    const cur = this.invites[i];
    if (cur === undefined) return false;
    this.invites[i] = { ...cur, status, respondedBy: by, respondedAtMs: atMs };
    return true;
  }

  async getEta(storeId: string) {
    return this.eta.get(storeId) ?? null;
  }
  async saveEta(rec: EtaRecord) {
    this.eta.set(rec.storeId, rec);
  }

  async addEvent(e: SettingsEvent) {
    this.events.push(e);
  }
  async listEvents(storeId: string, area: SettingsArea, limit: number) {
    return this.events.filter((e) => e.storeId === storeId && e.area === area).sort((a, b) => b.occurredAtMs - a.occurredAtMs).slice(0, limit);
  }
}
