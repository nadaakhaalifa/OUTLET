import { addresses, payouts, sellerSettings as ss } from "@outlet/domain";
import { sha256Hex } from "@outlet/idempotency";
import type { Clock, IdGenerator } from "../../../platform/ports";
import type {
  EtaRecord,
  EtaVerifierPort,
  FieldCipherPort,
  InviteDeliveryPort,
  InviteRecord,
  NameMatchPort,
  PlatformLimitsPort,
  ProfileRecord,
  SellerMembershipsAdminPort,
  SellerPayoutAccountPort,
  SellerPayoutAccountView,
  SettingsArea,
  SettingsRepository,
  ShippingRecord,
  StoreIdentity,
  StoreIdentityPort,
  StrongFactorPort,
  UploadScanPort,
  UploadStorePort,
} from "../domain/ports";

export class NameMismatchError extends ss.SellerSettingsError {
  constructor(
    readonly score: number,
    readonly evidence: readonly ss.NameMatchEvidence[],
  ) {
    super("name_mismatch");
  }
}

const fail = (code: string): never => {
  throw new ss.SellerSettingsError(code);
};

export interface SettingsDeps {
  readonly repo: SettingsRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly identity: StoreIdentityPort;
  readonly limits: PlatformLimitsPort;
  readonly uploads: UploadStorePort;
  readonly scan: UploadScanPort;
  readonly nameMatch: NameMatchPort;
  readonly strongFactor: StrongFactorPort;
  readonly memberships: SellerMembershipsAdminPort;
  readonly delivery: InviteDeliveryPort;
  readonly eta: EtaVerifierPort;
  readonly cipher: FieldCipherPort;
}

export interface ProfileInput {
  readonly nameAr: string;
  readonly nameEn?: string | null | undefined;
  readonly descriptionAr?: string | null | undefined;
  readonly descriptionEn?: string | null | undefined;
  readonly socialLinks: Readonly<Record<string, string | undefined>>;
  readonly returnPolicy: ss.ReturnPolicyInput;
  readonly freeDeliveryThreshold: bigint;
}

export interface ShippingInput {
  readonly origin: ss.ShippingOrigin;
  readonly handlingHours: number;
  readonly courierPreferences: Readonly<Record<string, readonly string[]>>;
  readonly packaging: readonly string[];
}

const phoneAad = (storeId: string): string => `seller-shipping:${storeId}:contact_phone`;
const bankAad = (id: string, field: "iban" | "holder"): string => `seller-bank:${id}:${field}`;

export class SettingsService {
  constructor(private readonly d: SettingsDeps) {}

  private async event(
    storeId: string,
    area: SettingsArea,
    kind: string,
    actorId: string | null,
    detail: Readonly<Record<string, string | number | boolean | null>> = {},
  ): Promise<void> {
    await this.d.repo.addEvent({ id: this.d.ids.uuidV7(), storeId, area, kind, actorId, occurredAtMs: this.d.clock.nowMs(), detail });
  }

  private async requireIdentity(storeId: string): Promise<StoreIdentity> {
    const id = await this.d.identity.identity(storeId);
    return id ?? fail("store_not_found");
  }

  // --------------------------------------------------------------------- profile
  private async profileOrDefault(storeId: string): Promise<ProfileRecord> {
    const cur = await this.d.repo.getProfile(storeId);
    if (cur !== null) return cur;
    const id = await this.requireIdentity(storeId);
    return {
      storeId,
      nameAr: id.nameAr,
      nameEn: id.nameEn,
      descriptionAr: null,
      descriptionEn: null,
      logoKey: null,
      coverKey: null,
      socialLinks: {},
      returnPolicy: ss.DEFAULT_RETURN_POLICY,
      freeDeliveryThreshold: ss.DEFAULT_FREE_DELIVERY_THRESHOLD,
      vacation: ss.NO_VACATION,
      version: 0,
      updatedBy: null,
      updatedAtMs: this.d.clock.nowMs(),
    };
  }

  async getProfile(storeId: string): Promise<ProfileRecord> {
    return this.profileOrDefault(storeId);
  }

  private async persistProfile(next: ProfileRecord, prev: ProfileRecord): Promise<ProfileRecord> {
    const saved: ProfileRecord = { ...next, version: prev.version + 1, updatedAtMs: this.d.clock.nowMs() };
    const ok = await this.d.repo.saveProfile(saved, prev.version === 0 ? null : prev.version);
    if (!ok) fail("version_conflict");
    return saved;
  }

  async updateProfile(storeId: string, actorId: string, input: ProfileInput): Promise<ProfileRecord> {
    const prev = await this.profileOrDefault(storeId);
    const max = await this.d.limits.freeDeliveryMax();
    const next: ProfileRecord = {
      ...prev,
      nameAr: ss.validateDisplayNameAr(input.nameAr),
      nameEn: ss.validateOptionalText(input.nameEn, 200, "name_en_length"),
      descriptionAr: ss.validateOptionalText(input.descriptionAr, 2000, "description_length"),
      descriptionEn: ss.validateOptionalText(input.descriptionEn, 2000, "description_length"),
      socialLinks: ss.validateSocialLinks(input.socialLinks),
      returnPolicy: ss.validateReturnPolicy(input.returnPolicy),
      freeDeliveryThreshold: ss.validateFreeDeliveryThreshold(input.freeDeliveryThreshold, max),
      updatedBy: actorId,
    };
    // Bilingual names: an existing English name can be changed but not removed. Legacy stores without one are
    // not blocked here (they are held at the go-live checklist item `add_english_store_name`).
    if (next.nameEn === null && prev.nameEn !== null && prev.nameEn.trim().length > 0) fail("name_en_required");
    const saved = await this.persistProfile(next, prev);
    await this.event(storeId, "profile", "profile.updated", actorId, {
      change_of_mind_days: saved.returnPolicy.changeOfMindDays,
      defect_days: saved.returnPolicy.defectDays,
      threshold_piastres: saved.freeDeliveryThreshold.toString(),
    });
    return saved;
  }

  async setVacation(storeId: string, actorId: string, input: ss.Vacation): Promise<ProfileRecord> {
    const prev = await this.profileOrDefault(storeId);
    const vacation = ss.validateVacation(input, this.d.clock.nowMs());
    const saved = await this.persistProfile({ ...prev, vacation, updatedBy: actorId }, prev);
    await this.event(storeId, "profile", vacation.enabled ? "vacation.on" : "vacation.off", actorId, {
      until_ms: vacation.untilMs,
      eta_extra_days: vacation.etaExtraDays,
    });
    return saved;
  }

  /** What shoppers see (B5 legal identity projection). Never includes staff, bank or shipping origin details. */
  async preview(storeId: string) {
    const [p, id, ship] = await Promise.all([this.profileOrDefault(storeId), this.requireIdentity(storeId), this.d.repo.getShipping(storeId)]);
    const now = this.d.clock.nowMs();
    return {
      slug: id.slug,
      kind: id.kind,
      verifiedBadge: id.verifiedBadge,
      nameAr: p.nameAr,
      nameEn: p.nameEn,
      descriptionAr: p.descriptionAr,
      descriptionEn: p.descriptionEn,
      logoUrl: p.logoKey === null ? null : this.d.uploads.publicUrl(p.logoKey),
      coverUrl: p.coverKey === null ? null : this.d.uploads.publicUrl(p.coverKey),
      socialLinks: p.socialLinks,
      returnPolicy: p.returnPolicy,
      freeDeliveryThreshold: p.freeDeliveryThreshold,
      acceptingOrders: ss.acceptsNewOrders(p.vacation, now),
      onVacationUntilMs: ss.isOnVacation(p.vacation, now) ? p.vacation.untilMs : null,
      etaExtraDays: ss.etaExtraDaysFor(p.vacation, now),
      handlingHours: ship?.handlingHours ?? ss.DEFAULT_HANDLING_HOURS,
      legalIdentity: id.legal,
    };
  }

  // --------------------------------------------------------------------- media
  async requestUpload(storeId: string, actorId: string, slot: ss.ImageSlot, contentType: string, byteSize: number) {
    const type = ss.validateUploadRequest(slot, contentType, byteSize);
    const now = this.d.clock.nowMs();
    const id = this.d.ids.uuidV7();
    const key = ss.objectKeyFor(storeId, slot, id, type);
    const signed = await this.d.uploads.signPut({ key, contentType: type, maxBytes: ss.IMAGE_LIMITS[slot].maxBytes, ttlSeconds: ss.UPLOAD_URL_TTL_SECONDS, nowMs: now });
    await this.d.repo.createUpload({
      id,
      storeId,
      slot,
      objectKey: key,
      contentType: type,
      declaredBytes: byteSize,
      status: "issued",
      rejectCode: null,
      width: null,
      height: null,
      createdBy: actorId,
      createdAtMs: now,
      expiresAtMs: signed.expiresAtMs,
    });
    return { uploadId: id, key, signed };
  }

  async requestBulkProductUploads(storeId: string, actorId: string, items: readonly { contentType: string; byteSize: number }[]) {
    if (items.length < 1 || items.length > ss.MAX_BULK_UPLOADS) fail("bulk_count_invalid");
    // Validate everything first so a bad item issues no URL at all.
    items.forEach((i) => ss.validateUploadRequest("product", i.contentType, i.byteSize));
    const out = [];
    for (const i of items) out.push(await this.requestUpload(storeId, actorId, "product", i.contentType, i.byteSize));
    return out;
  }

  async confirmUpload(storeId: string, actorId: string, uploadId: string) {
    const u = (await this.d.repo.getUpload(storeId, uploadId)) ?? fail("upload_not_found");
    if (u.status === "confirmed") return u;
    if (u.status !== "issued") fail("upload_not_pending");
    const now = this.d.clock.nowMs();
    if (now > u.expiresAtMs + 3_600_000) fail("upload_expired");
    const obj = await this.d.scan.inspect(u.objectKey);
    if (obj === null) fail("upload_missing_in_storage");
    const o = obj ?? fail("upload_missing_in_storage");
    if (o.malware === "pending") fail("scan_pending");
    const reject = async (code: string): Promise<never> => {
      await this.d.repo.markUpload(storeId, uploadId, { status: "rejected", rejectCode: code, atMs: now });
      await this.event(storeId, "media", "upload.rejected", actorId, { slot: u.slot, code });
      return fail(code);
    };
    if (o.malware === "infected") return reject("upload_infected");
    let facts: ss.ImageFacts;
    try {
      facts = ss.validateImageFacts(u.slot, u.contentType, o.byteSize, ss.sniffImage(o.head));
    } catch (e) {
      if (e instanceof ss.SellerSettingsError) return reject(e.code);
      throw e;
    }
    await this.d.repo.markUpload(storeId, uploadId, { status: "confirmed", width: facts.width, height: facts.height, atMs: now });
    if (u.slot === "logo" || u.slot === "cover") {
      const prev = await this.profileOrDefault(storeId);
      await this.persistProfile(
        { ...prev, ...(u.slot === "logo" ? { logoKey: u.objectKey } : { coverKey: u.objectKey }), updatedBy: actorId },
        prev,
      );
    }
    await this.event(storeId, "media", "upload.confirmed", actorId, { slot: u.slot, width: facts.width, height: facts.height });
    return { ...u, status: "confirmed" as const, width: facts.width, height: facts.height };
  }

  // --------------------------------------------------------------------- payout account
  async getPayoutAccount(storeId: string) {
    const a = await this.d.repo.activeAccount(storeId);
    if (a === null) return null;
    return { ...a, hold: ss.payoutHold(a.activatesAtMs, this.d.clock.nowMs()) };
  }

  async setPayoutAccount(storeId: string, actorId: string, input: { iban: string; holderName: string }) {
    const now = this.d.clock.nowMs();
    if (!(await this.d.strongFactor.isRecent({ userId: actorId, nowMs: now, maxAgeSec: ss.BANK_CHANGE_STRONG_FACTOR_MAX_AGE_SEC }))) {
      fail("strong_factor_required");
    }
    let iban: string;
    try {
      iban = payouts.assertEgyptIban(input.iban);
    } catch {
      return fail("invalid_iban");
    }
    const holder = input.holderName.trim();
    if (holder.length < 2 || holder.length > 200) fail("holder_name_length");
    const identity = await this.requireIdentity(storeId);
    const match = await this.d.nameMatch.compare(holder, identity.legal.legalName);
    if (match.decision !== "match") {
      await this.event(storeId, "payout_account", "payout_account.name_mismatch", actorId, { score: match.score });
      throw new NameMismatchError(match.score, match.evidence);
    }
    const current = await this.d.repo.activeAccount(storeId);
    const last4 = payouts.ibanLast4(iban);
    if (current !== null && current.ibanLast4 === last4 && (await this.d.cipher.decrypt(current.ibanEnc, bankAad(current.id, "iban")).catch(() => "")) === iban) {
      fail("iban_unchanged");
    }
    const id = this.d.ids.uuidV7();
    const record = {
      id,
      storeId,
      accountToken: `acct_${this.d.ids.hex(16)}`,
      ibanEnc: await this.d.cipher.encrypt(iban, bankAad(id, "iban")),
      ibanLast4: last4,
      holderNameEnc: await this.d.cipher.encrypt(holder, bankAad(id, "holder")),
      legalNameScore: match.score,
      status: "ACTIVE" as const,
      createdBy: actorId,
      createdAtMs: now,
      activatesAtMs: ss.activationTimeFor(now, current !== null),
    };
    await this.d.repo.replaceAccount(record);
    await this.event(storeId, "payout_account", current === null ? "payout_account.set" : "payout_account.replaced", actorId, {
      last4,
      score: match.score,
      activates_at_ms: record.activatesAtMs,
    });
    return { ...record, hold: ss.payoutHold(record.activatesAtMs, now), score: match.score };
  }

  history(storeId: string, area: SettingsArea) {
    return this.d.repo.listEvents(storeId, area, 50);
  }

  // --------------------------------------------------------------------- shipping
  async getShipping(storeId: string) {
    const s = await this.d.repo.getShipping(storeId);
    if (s === null) return null;
    const phone = await this.d.cipher.decrypt(s.contactPhoneEnc, phoneAad(storeId));
    return { ...s, contactPhoneMasked: ss.maskPhone(phone) };
  }

  async putShipping(storeId: string, actorId: string, input: ShippingInput) {
    const phone = addresses.normalizeEgPhone(input.origin.contactPhoneE164);
    if (phone === null) fail("origin_contact_invalid");
    const origin = ss.validateOrigin({ ...input.origin, contactPhoneE164: phone ?? "" });
    const prev = await this.d.repo.getShipping(storeId);
    const rec: ShippingRecord = {
      storeId,
      governorateCode: origin.governorateCode,
      cityCode: origin.cityCode,
      street: origin.street,
      building: origin.building,
      landmark: origin.landmark,
      contactName: origin.contactName,
      contactPhoneEnc: await this.d.cipher.encrypt(origin.contactPhoneE164, phoneAad(storeId)),
      pin: origin.pin,
      handlingHours: ss.validateHandlingHours(input.handlingHours),
      courierPreferences: ss.validateCourierPreferences(input.courierPreferences),
      packaging: ss.validatePackaging(input.packaging),
      version: (prev?.version ?? 0) + 1,
      updatedBy: actorId,
    };
    if (!(await this.d.repo.saveShipping(rec, prev === null ? null : prev.version))) fail("version_conflict");
    await this.event(storeId, "shipping", "shipping.updated", actorId, { handling_hours: rec.handlingHours, governorate: rec.governorateCode });
    return (await this.getShipping(storeId)) ?? fail("store_not_found");
  }

  // --------------------------------------------------------------------- notifications
  getPrefs(storeId: string) {
    return this.d.repo.getPrefs(storeId);
  }
  async updatePrefs(storeId: string, actorId: string, update: Partial<Record<ss.SellerNotificationEvent, Partial<Record<ss.SellerChannel, boolean>>>>) {
    const next = ss.applyPrefUpdate(await this.d.repo.getPrefs(storeId), update);
    await this.d.repo.savePrefs(storeId, next, actorId, this.d.clock.nowMs());
    await this.event(storeId, "notifications", "notifications.updated", actorId, { events: Object.keys(update).length });
    return next;
  }

  // --------------------------------------------------------------------- team
  async listTeam(storeId: string) {
    const [members, invites] = await Promise.all([this.d.memberships.listMembers(storeId), this.d.repo.listInvites(storeId)]);
    return { members, invites };
  }

  async invite(storeId: string, actorId: string, input: { phone: string; role: ss.SellerTeamRole }) {
    const now = this.d.clock.nowMs();
    const phone = addresses.normalizeEgPhone(input.phone);
    if (phone === null) return fail("phone_invalid");
    if ((await this.d.repo.countPendingInvites(storeId, now)) >= ss.MAX_PENDING_INVITES) fail("too_many_pending_invites");
    const members = await this.d.memberships.listMembers(storeId);
    if (members.some((m) => m.phoneE164 === phone)) fail("already_member");
    const token = this.d.ids.hex(32);
    const inv: InviteRecord = {
      id: this.d.ids.uuidV7(),
      storeId,
      role: input.role,
      phoneBlind: await this.d.cipher.blindIndex("seller-invite-phone", phone),
      phoneEnc: await this.d.cipher.encrypt(phone, `seller-invite:${storeId}:phone`),
      phoneMasked: ss.maskPhone(phone),
      tokenHash: sha256Hex(token),
      status: "PENDING",
      invitedBy: actorId,
      respondedBy: null,
      createdAtMs: now,
      expiresAtMs: now + ss.INVITE_TTL_MS,
      respondedAtMs: null,
    };
    if ((await this.d.repo.insertInvite(inv)) === "duplicate_pending") fail("duplicate_pending_invite");
    await this.d.delivery.deliver({ phoneE164: phone, token, storeId, expiresAtMs: inv.expiresAtMs });
    await this.event(storeId, "team", "team.invited", actorId, { role: input.role, invite_id: inv.id });
    return inv;
  }

  async revokeInvite(storeId: string, actorId: string, inviteId: string): Promise<void> {
    const inv = (await this.d.repo.getInvite(storeId, inviteId)) ?? fail("invite_not_found");
    if (inv === undefined) return;
    if (!(await this.d.repo.closeInvite(inviteId, "REVOKED", actorId, this.d.clock.nowMs()))) fail("invite_not_pending");
    await this.event(storeId, "team", "team.invite_revoked", actorId, { invite_id: inviteId });
  }

  private async resolveInvite(userId: string, token: string): Promise<InviteRecord> {
    const inv = await this.d.repo.getInviteByTokenHash(sha256Hex(token));
    // Unknown token and a token for someone else's phone look identical (no enumeration).
    if (inv === null) return fail("invite_not_found");
    const phone = await this.d.memberships.phoneOf(userId);
    const blind = phone === null ? null : await this.d.cipher.blindIndex("seller-invite-phone", phone);
    if (blind === null || Buffer.compare(Buffer.from(blind), Buffer.from(inv.phoneBlind)) !== 0) return fail("invite_not_found");
    if (inv.status !== "PENDING") return fail("invite_not_pending");
    if (ss.isInviteExpired(inv.expiresAtMs, this.d.clock.nowMs())) {
      await this.d.repo.closeInvite(inv.id, "EXPIRED", null, this.d.clock.nowMs());
      return fail("invite_expired");
    }
    return inv;
  }

  async acceptInvite(userId: string, token: string) {
    const inv = await this.resolveInvite(userId, token);
    if (!(await this.d.repo.closeInvite(inv.id, "ACCEPTED", userId, this.d.clock.nowMs()))) fail("invite_not_pending");
    await this.d.memberships.createGrant({ storeId: inv.storeId, userId, role: inv.role });
    await this.event(inv.storeId, "team", "team.invite_accepted", userId, { role: inv.role, invite_id: inv.id });
    return { storeId: inv.storeId, role: inv.role };
  }

  async declineInvite(userId: string, token: string): Promise<void> {
    const inv = await this.resolveInvite(userId, token);
    if (!(await this.d.repo.closeInvite(inv.id, "DECLINED", userId, this.d.clock.nowMs()))) fail("invite_not_pending");
    await this.event(inv.storeId, "team", "team.invite_declined", userId, { invite_id: inv.id });
  }

  async changeMember(storeId: string, actorId: string, targetUserId: string, newRole: ss.SellerTeamRole | null): Promise<void> {
    const members = await this.d.memberships.listMembers(storeId);
    ss.assertCanChangeMember({ actorRole: "owner", members, targetUserId, newRole });
    if (newRole === null) await this.d.memberships.removeMember({ storeId, userId: targetUserId });
    else await this.d.memberships.changeRole({ storeId, userId: targetUserId, role: newRole });
    await this.event(storeId, "team", newRole === null ? "team.member_removed" : "team.role_changed", actorId, {
      target: targetUserId,
      role: newRole,
    });
  }

  // --------------------------------------------------------------------- eta
  async getEta(storeId: string): Promise<EtaRecord> {
    return (
      (await this.d.repo.getEta(storeId)) ?? {
        storeId,
        status: "not_enrolled",
        failureCode: null,
        requestedAtMs: null,
        lastCheckedAtMs: null,
        lastVerifiedAtMs: null,
      }
    );
  }

  async requestEta(storeId: string, actorId: string): Promise<EtaRecord> {
    const now = this.d.clock.nowMs();
    const cur = await this.getEta(storeId);
    let rec: EtaRecord = { ...cur, status: ss.etaTransition(cur.status, "request"), failureCode: null, requestedAtMs: now };
    const result = await this.d.eta.verify(storeId);
    if (result !== "unavailable") {
      rec = {
        ...rec,
        status: ss.etaTransition(rec.status, result),
        lastCheckedAtMs: now,
        lastVerifiedAtMs: result === "verified" ? now : cur.lastVerifiedAtMs,
        failureCode: result === "failed" ? "verification_failed" : null,
      };
    }
    await this.d.repo.saveEta(rec, actorId, now);
    await this.event(storeId, "eta", "eta.requested", actorId, { status: rec.status });
    return rec;
  }

  async revokeEta(storeId: string, actorId: string): Promise<EtaRecord> {
    const cur = await this.getEta(storeId);
    const rec: EtaRecord = { ...cur, status: ss.etaTransition(cur.status, "revoke") };
    await this.d.repo.saveEta(rec, actorId, this.d.clock.nowMs());
    await this.event(storeId, "eta", "eta.revoked", actorId, {});
    return rec;
  }
}

/** The public port the payouts module reads. A cooling replacement reports `holdUntilMs` so payouts to it stay held. */
export class SettingsPayoutAccountAdapter implements SellerPayoutAccountPort {
  constructor(
    private readonly repo: SettingsRepository,
    private readonly identity: StoreIdentityPort,
  ) {}
  async activeAccount(storeId: string, nowMs: number): Promise<SellerPayoutAccountView | null> {
    const a = await this.repo.activeAccount(storeId);
    if (a === null) return null;
    const id = await this.identity.identity(storeId);
    if (id === null) return null;
    const hold = ss.payoutHold(a.activatesAtMs, nowMs);
    return { accountToken: a.accountToken, ibanLast4: a.ibanLast4, legalName: id.legal.legalName, holdUntilMs: hold.untilMs };
  }
}

/**
 * Read adapter for the orders module's SellerReturnWindowPort (structural; no cross-module import).
 * Returns the seller's LONGEST return window in days: max(change-of-mind, defect), because order lines
 * close (and payouts/creator accruals release) only after every return right has lapsed. Null when the
 * store has no profile row: orders then applies the statutory 30 days + 3-day margin. Orders floors the
 * value at 30 itself, and the profile validator plus DB CHECKs already forbid anything below it.
 *
 * Read-time semantics (decision, owner-approved Option A): the value is read when `closeDelivered`
 * runs, NOT snapshotted at delivery. A later profile change can therefore shorten or extend the window
 * for deliveries that happened earlier. A snapshot on the seller order is a follow-up (orders schema
 * change, not approved yet).
 */
export class SettingsReturnWindowAdapter {
  constructor(private readonly repo: SettingsRepository) {}
  async returnWindowDays(storeId: string): Promise<number | null> {
    const p = await this.repo.getProfile(storeId);
    if (p === null) return null;
    return Math.max(p.returnPolicy.changeOfMindDays, p.returnPolicy.defectDays);
  }
}
