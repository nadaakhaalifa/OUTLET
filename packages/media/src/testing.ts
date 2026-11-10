import { createHmac, timingSafeEqual } from "node:crypto";
import type { AvScanPort, AvScanResult, SignerPort, StoragePort } from "./ports.js";

export class InMemoryStorage implements StoragePort {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { bytes, contentType });
    return Promise.resolve();
  }
  get(key: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.objects.get(key)?.bytes ?? null);
  }
  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
}

export class HmacSigner implements SignerPort {
  constructor(private readonly secret: string, private readonly base = "https://storage.invalid") {}
  private mac(key: string, exp: number): string {
    return createHmac("sha256", this.secret).update(`${key}\n${String(exp)}`).digest("hex");
  }
  sign(key: string, expiresAt: Date): string {
    const exp = Math.floor(expiresAt.getTime() / 1000);
    return `${this.base}/${key}?exp=${String(exp)}&sig=${this.mac(key, exp)}`;
  }
  verify(url: string, now: Date): boolean {
    const u = new URL(url);
    const exp = Number(u.searchParams.get("exp"));
    const sig = u.searchParams.get("sig") ?? "";
    const expected = this.mac(decodeURIComponent(u.pathname.slice(1)), exp);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b) && exp * 1000 > now.getTime();
  }
}

export class FakeAvScanner implements AvScanPort {
  constructor(private readonly verdict: AvScanResult = { clean: true }) {}
  scan(): Promise<AvScanResult> {
    return Promise.resolve(this.verdict);
  }
}
