import { compareForDisplay, isLive, type HomeBanner } from "../domain/banner";
import type { BannerAuditEntry, BannerAuditPort, BannerFlagPort, BannerImageUrlPort, HomeBannerStore } from "../domain/ports";

export class InMemoryHomeBannerStore implements HomeBannerStore {
  private readonly rows = new Map<string, HomeBanner>();

  async insert(b: HomeBanner): Promise<void> {
    if (this.rows.has(b.id)) throw new Error("duplicate home banner id");
    this.rows.set(b.id, b);
  }
  async get(id: string): Promise<HomeBanner | null> {
    return this.rows.get(id) ?? null;
  }
  async replace(next: HomeBanner, expectedVersion: number): Promise<HomeBanner | null> {
    const cur = this.rows.get(next.id);
    if (cur === undefined || cur.version !== expectedVersion) return null;
    const saved: HomeBanner = { ...next, version: cur.version + 1 };
    this.rows.set(saved.id, saved);
    return saved;
  }
  async remove(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }
  async list(limit: number): Promise<readonly HomeBanner[]> {
    return [...this.rows.values()].sort((a, b) => b.createdAtMs - a.createdAtMs || (a.id < b.id ? 1 : -1)).slice(0, limit);
  }
  async listScheduledAt(nowMs: number, limit: number): Promise<readonly HomeBanner[]> {
    return [...this.rows.values()].filter((b) => isLive(b, nowMs)).sort(compareForDisplay).slice(0, limit);
  }
}

export class StaticBannerFlags implements BannerFlagPort {
  constructor(private readonly on: Set<string>) {}
  isEnabled(key: string): boolean {
    return this.on.has(key);
  }
  set(key: string, v: boolean): void {
    if (v) this.on.add(key);
    else this.on.delete(key);
  }
}

export class RecordingBannerAudit implements BannerAuditPort {
  readonly entries: BannerAuditEntry[] = [];
  failNext = false;
  async append(e: BannerAuditEntry): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("audit down");
    }
    this.entries.push(e);
  }
}

export class FakeBannerImageUrls implements BannerImageUrlPort {
  urlFor(key: string): string {
    return `https://media.example.test/${key}`;
  }
}

/** Production default until a media base is bound: the image is omitted and the app draws `art_variant`. */
export class UnconfiguredBannerImageUrls implements BannerImageUrlPort {
  urlFor(): null {
    return null;
  }
}
