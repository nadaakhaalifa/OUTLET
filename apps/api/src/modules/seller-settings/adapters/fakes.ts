import { sellerSettings as ss } from "@outlet/domain";
import { createHmac } from "node:crypto";
import type {
  EtaVerifierPort,
  FieldCipherPort,
  InspectedObject,
  InviteDeliveryPort,
  MemberFacts,
  NameMatchPort,
  PlatformLimitsPort,
  SellerMembershipsAdminPort,
  SignedUpload,
  StoreIdentity,
  StoreIdentityPort,
  StrongFactorPort,
  UploadScanPort,
  UploadStorePort,
} from "../domain/ports";

/** DEVELOPMENT FIXTURES. Never composed in production. */
export class FakeStoreIdentity implements StoreIdentityPort {
  readonly stores = new Map<string, StoreIdentity>();
  add(storeId: string, id: StoreIdentity): void {
    this.stores.set(storeId, id);
  }
  async identity(storeId: string) {
    return this.stores.get(storeId) ?? null;
  }
}

export class StaticLimits implements PlatformLimitsPort {
  constructor(private readonly max: bigint = ss.DEFAULT_FREE_DELIVERY_ADMIN_MAX) {}
  async freeDeliveryMax() {
    return this.max;
  }
}

export class FakeUploadStore implements UploadStorePort {
  readonly signed: string[] = [];
  async signPut(input: { key: string; contentType: string; maxBytes: number; ttlSeconds: number; nowMs: number }): Promise<SignedUpload> {
    this.signed.push(input.key);
    return {
      url: `https://uploads.invalid/${input.key}?sig=dev`,
      method: "PUT",
      headers: { "Content-Type": input.contentType, "Content-Length-Range": `1,${input.maxBytes}` },
      expiresAtMs: input.nowMs + input.ttlSeconds * 1000,
    };
  }
  publicUrl(key: string): string {
    return `https://cdn.invalid/${key}`;
  }
}

export class FakeUploadScan implements UploadScanPort {
  readonly objects = new Map<string, InspectedObject>();
  async inspect(key: string) {
    return this.objects.get(key) ?? null;
  }
}

export class DomainNameMatch implements NameMatchPort {
  async compare(holderName: string, legalName: string) {
    return ss.scoreNameMatch(holderName, legalName);
  }
}

export class FakeStrongFactor implements StrongFactorPort {
  readonly stale = new Set<string>();
  async isRecent(input: { userId: string }) {
    return !this.stale.has(input.userId);
  }
}

export class FakeMemberships implements SellerMembershipsAdminPort {
  readonly members = new Map<string, MemberFacts[]>();
  readonly phones = new Map<string, string>();
  seed(storeId: string, m: MemberFacts): void {
    this.members.set(storeId, [...(this.members.get(storeId) ?? []), m]);
    if (m.phoneE164 !== null) this.phones.set(m.userId, m.phoneE164);
  }
  async listMembers(storeId: string) {
    return this.members.get(storeId) ?? [];
  }
  async phoneOf(userId: string) {
    return this.phones.get(userId) ?? null;
  }
  async createGrant(i: { storeId: string; userId: string; role: ss.SellerTeamRole }) {
    this.seed(i.storeId, { userId: i.userId, role: i.role, phoneE164: this.phones.get(i.userId) ?? null, joinedAtMs: 0 });
  }
  async changeRole(i: { storeId: string; userId: string; role: ss.SellerTeamRole }) {
    this.members.set(i.storeId, (this.members.get(i.storeId) ?? []).map((m) => (m.userId === i.userId ? { ...m, role: i.role } : m)));
  }
  async removeMember(i: { storeId: string; userId: string }) {
    this.members.set(i.storeId, (this.members.get(i.storeId) ?? []).filter((m) => m.userId !== i.userId));
  }
}

export class RecordingInviteDelivery implements InviteDeliveryPort {
  readonly sent: { phoneE164: string; token: string; storeId: string; expiresAtMs: number }[] = [];
  async deliver(i: { phoneE164: string; token: string; storeId: string; expiresAtMs: number }) {
    this.sent.push(i);
  }
}

export class FakeEtaVerifier implements EtaVerifierPort {
  result: "verified" | "failed" | "unavailable" = "unavailable";
  async verify() {
    return this.result;
  }
}

/** Deterministic NON-SECURE cipher for tests and dev: reversible tagging, HMAC blind index. */
export class FakeFieldCipher implements FieldCipherPort {
  async encrypt(plaintext: string, aad: string) {
    return Buffer.from(`enc:${aad}:${plaintext}`, "utf8");
  }
  async decrypt(ciphertext: Uint8Array, aad: string) {
    const s = Buffer.from(ciphertext).toString("utf8");
    const prefix = `enc:${aad}:`;
    if (!s.startsWith(prefix)) throw new Error("aad_mismatch");
    return s.slice(prefix.length);
  }
  async blindIndex(purpose: string, value: string) {
    return createHmac("sha256", "dev-blind-key").update(`${purpose}:${value}`).digest();
  }
}
