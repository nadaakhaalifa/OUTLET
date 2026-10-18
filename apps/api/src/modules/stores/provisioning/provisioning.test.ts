import { describe, expect, it } from "vitest";
import { InMemoryStoreRepository } from "../adapters/in-memory";
import { BrandApplicationEventConsumer, RetryFailedProvisioning } from "./consumer";
import {
  ApprovedPayload,
  baseSlug,
  deterministicStoreId,
  normalizeBrandName,
  uniqueSlug,
  type ProvisioningFailureCode,
} from "./domain";
import {
  InMemoryConflictQueue,
  InMemoryInboxRunner,
  InMemoryProvisioningApplications,
  InMemoryProvisioningEvents,
  InMemorySellerMemberships,
  InMemoryStoreOnboarding,
  RecordingBrandNotifier,
} from "./in-memory";
import { ProvisionStoreFromApproval } from "./provision-store";

const APP = "0192f3a4-5b6c-7d8e-9f01-000000000101";
const APP2 = "0192f3a4-5b6c-7d8e-9f01-000000000102";
const USER = "0192f3a4-5b6c-7d8e-9f01-000000000201";
const USER2 = "0192f3a4-5b6c-7d8e-9f01-000000000202";
const MSG = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(900 + n).padStart(12, "0")}`;

const payload = (over: Record<string, unknown> = {}): ApprovedPayload =>
  ApprovedPayload.parse({
    application_id: APP,
    applicant_seller_user_id: USER,
    brand_kind: "local",
    country: "EG",
    brand_name: "Nile Basics",
    brand_name_ar: "أساسيات النيل",
    legal_name_ar: "شركة النيل للملابس",
    registration_no: "123456",
    tax_card_no: "555-111-222",
    governorate: "Cairo",
    eta_registration: "registered",
    ...over,
  });

function setup() {
  const stores = new InMemoryStoreRepository([]);
  const memberships = new InMemorySellerMemberships();
  const onboarding = new InMemoryStoreOnboarding();
  const applications = new InMemoryProvisioningApplications();
  const events = new InMemoryProvisioningEvents();
  const conflicts = new InMemoryConflictQueue();
  const notifier = new RecordingBrandNotifier();
  const provision = new ProvisionStoreFromApproval({ stores, memberships, onboarding, applications, events, conflicts });
  const consumer = new BrandApplicationEventConsumer(new InMemoryInboxRunner(), provision, applications, notifier);
  const retry = new RetryFailedProvisioning(provision, applications, notifier);
  return { stores, memberships, onboarding, applications, events, conflicts, notifier, provision, consumer, retry };
}

describe("pure helpers", () => {
  it("derives a stable store id per application and distinct ids for distinct applications", () => {
    expect(deterministicStoreId(APP)).toBe(deterministicStoreId(APP));
    expect(deterministicStoreId(APP)).not.toBe(deterministicStoreId(APP2));
    expect(deterministicStoreId(APP)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("slugs: latin names slugify, Arabic-only fall back, hint wins, reserved words are suffixed, collisions count up", () => {
    expect(baseSlug("Nile Basics!", null, APP)).toBe("nile-basics");
    expect(baseSlug("أساسيات", null, APP)).toBe("brand-000000000101".slice(0, 6) + APP.replaceAll("-", "").slice(-8));
    expect(baseSlug("Whatever", "chosen-slug", APP)).toBe("chosen-slug");
    expect(baseSlug("Admin", null, APP)).toBe("admin-store");
    expect(uniqueSlug("a", new Set(["a", "a-2"]))).toBe("a-3");
    expect(uniqueSlug("b", new Set(["a"]))).toBe("b");
  });
  it("name normalization folds Arabic letters, case, diacritics and punctuation", () => {
    expect(normalizeBrandName("Nile  Basics!")).toBe(normalizeBrandName("nile-basics"));
    expect(normalizeBrandName("مَدرسة")).toBe(normalizeBrandName("مدرسه"));
    expect(normalizeBrandName("أحمد")).toBe(normalizeBrandName("احمد"));
  });
});

describe("ProvisionStoreFromApproval", () => {
  it("creates an active, approved, B5-complete store, owner grant, checklist and ETA placeholder", async () => {
    const s = setup();
    const r = await s.provision.execute(payload());
    expect(r.kind).toBe("created");
    if (r.kind !== "created") return;
    const store = await s.stores.findById(r.storeId);
    expect(store).toMatchObject({
      kind: "local",
      slug: "nile-basics",
      status: "ACTIVE",
      sellerKycState: "APPROVED",
      sellerId: USER,
      nameAr: "أساسيات النيل",
      nameEn: "Nile Basics",
      verifiedBadge: false,
      legalIdentity: { legalNameAr: "شركة النيل للملابس", commercialRegisterNo: "123456", taxCardNo: "555-111-222", governorate: "Cairo" },
    });
    expect(s.memberships.storesOwnedBy(USER)).toEqual([r.storeId]);
    expect(s.onboarding.checklists.get(r.storeId)?.length).toBeGreaterThan(3);
    expect(s.onboarding.eta.get(r.storeId)).toBe("registered");
    expect(s.applications.provisioned.get(APP)).toBe(r.storeId);
    expect(s.events.published.map((e) => e.type)).toEqual(["store.provisioned"]);
  });

  it("global brands get kind global, no ETA placeholder and the country as jurisdiction", async () => {
    const s = setup();
    const r = await s.provision.execute(payload({ brand_kind: "global", country: "AE", governorate: null, brand_name_ar: null, legal_name_ar: null, legal_name_en: "Gulf Basics LLC" }));
    if (r.kind !== "created") throw new Error("expected created");
    const store = await s.stores.findById(r.storeId);
    expect(store?.kind).toBe("global");
    expect(store?.legalIdentity?.governorate).toBe("AE");
    expect(store?.legalIdentity?.legalNameAr).toBe("Gulf Basics LLC");
    expect(s.onboarding.eta.has(r.storeId)).toBe(false);
  });

  it("slug collisions get a numeric suffix and never overwrite", async () => {
    const s = setup();
    await s.provision.execute(payload());
    const second = await s.provision.execute(payload({ application_id: APP2, applicant_seller_user_id: USER2, brand_name: "Delta Wear", brand_name_ar: "اسم مختلف تماما", slug_hint: "nile-basics" }));
    if (second.kind !== "created") throw new Error("expected created");
    expect(second.slug).toBe("nile-basics-2");
    expect((await s.stores.all()).map((x) => x.slug).sort()).toEqual(["nile-basics", "nile-basics-2"]);
  });

  it("a duplicate store name goes to the admin conflict queue and parks the application, creating nothing", async () => {
    const s = setup();
    await s.provision.execute(payload());
    const r = await s.provision.execute(payload({ application_id: APP2, applicant_seller_user_id: USER2, brand_name: "NILE basics", brand_name_ar: null }));
    expect(r.kind).toBe("conflict");
    expect(s.conflicts.entries).toEqual([{ applicationId: APP2, reason: "store_name_conflict", conflictingStoreId: deterministicStoreId(APP) }]);
    expect(s.applications.failed.get(APP2)).toBe("store_name_conflict");
    expect(await s.stores.findById(deterministicStoreId(APP2))).toBeNull();
    expect(s.memberships.storesOwnedBy(USER2)).toEqual([]);
  });

  it("replaying the same application creates exactly one store and one event", async () => {
    const s = setup();
    for (let i = 0; i < 3; i += 1) await s.provision.execute(payload());
    expect(await s.stores.all()).toHaveLength(1);
    expect(s.events.published).toHaveLength(1);
    expect(s.memberships.owners.get(deterministicStoreId(APP))?.size).toBe(1);
  });
});

describe("BrandApplicationEventConsumer", () => {
  const approved = (n = 1) => ({ messageId: MSG(n), type: "brand_application.approved", payload: { application_id: APP } });

  it("provisions from the application facts (not the event), then notifies; replay of the message is a duplicate", async () => {
    const s = setup();
    s.applications.payloads.set(APP, payload());
    const r1 = await s.consumer.handle({ ...approved(), payload: { application_id: APP, applicant_seller_user_id: USER2, brand_name: "Forged" } });
    expect(r1.kind).toBe("provisioned");
    const stores = await s.stores.all();
    expect(stores).toHaveLength(1);
    expect(stores[0]?.sellerId).toBe(USER); // the event could not choose the owner
    expect(stores[0]?.nameEn).toBe("Nile Basics");
    expect(s.notifier.sent.map((n) => n.templateKey)).toEqual(["brand_application_approved"]);
    expect((await s.consumer.handle(approved())).kind).toBe("duplicate");
    expect(await s.stores.all()).toHaveLength(1);
  });

  it("the same approval under a NEW message id still creates exactly one store", async () => {
    const s = setup();
    s.applications.payloads.set(APP, payload());
    await s.consumer.handle(approved(1));
    const again = await s.consumer.handle(approved(2));
    expect(again).toMatchObject({ kind: "provisioned", result: { kind: "already_provisioned" } });
    expect(await s.stores.all()).toHaveLength(1);
    expect(s.notifier.sent).toHaveLength(1); // notification dedupes by (user, template, application)
  });

  it("a failure parks the application as provisioning_error, tells nobody, and the retry completes without a second store", async () => {
    const s = setup();
    s.applications.payloads.set(APP, payload());
    let fail = true;
    const grant = s.memberships.grantOwner.bind(s.memberships);
    s.memberships.grantOwner = async (i) => {
      if (fail) throw new Error("auth down");
      return grant(i);
    };
    const r = await s.consumer.handle(approved());
    expect(r).toEqual({ kind: "provisioning_failed", code: "provisioning_error" });
    expect(s.applications.failed.get(APP)).toBe<ProvisioningFailureCode>("provisioning_error");
    expect(s.notifier.sent).toHaveLength(0);
    expect(await s.stores.all()).toHaveLength(1); // store row exists (deterministic id), membership does not
    expect(s.memberships.storesOwnedBy(USER)).toEqual([]);

    fail = false;
    const swept = await s.retry.sweep();
    expect(swept).toEqual([expect.objectContaining({ kind: "provisioned" })]);
    expect(await s.stores.all()).toHaveLength(1);
    expect(s.memberships.storesOwnedBy(USER)).toEqual([deterministicStoreId(APP)]);
    expect(s.applications.failed.has(APP)).toBe(false);
    expect(s.applications.provisioned.get(APP)).toBe(deterministicStoreId(APP));
    expect(s.notifier.sent.map((n) => n.templateKey)).toEqual(["brand_application_approved"]);
    expect(s.events.published).toHaveLength(1);
  });

  it("a notification outage does not undo provisioning", async () => {
    const s = setup();
    s.applications.payloads.set(APP, payload());
    s.notifier.failNext = true;
    const r = await s.consumer.handle(approved());
    expect(r.kind).toBe("provisioned");
    expect(await s.stores.all()).toHaveLength(1);
  });

  it("received / needs_info / rejected / appeal result notify the applicant; rejection never creates a store", async () => {
    const s = setup();
    s.applications.payloads.set(APP, payload());
    const types = ["brand_application.submitted", "brand_application.needs_info", "brand_application.rejected", "brand_application.appeal_decided"];
    for (const [i, type] of types.entries()) {
      expect((await s.consumer.handle({ messageId: MSG(10 + i), type, payload: { application_id: APP } })).kind).toBe("notified");
    }
    expect(s.notifier.sent.map((n) => n.templateKey)).toEqual([
      "brand_application_received",
      "brand_application_needs_info",
      "brand_application_rejected",
      "brand_application_appeal_result",
    ]);
    expect(await s.stores.all()).toHaveLength(0);
    expect(s.memberships.owners.size).toBe(0);
    expect(s.notifier.sent.every((n) => n.userId === USER && n.deepLink === `/seller/applications/${APP}`)).toBe(true);
  });

  it("ignores unrelated events, rejects bad message ids and unreadable applications", async () => {
    const s = setup();
    expect((await s.consumer.handle({ messageId: MSG(1), type: "order_group.paid", payload: {} })).kind).toBe("ignored");
    expect((await s.consumer.handle({ messageId: "nope", type: "brand_application.approved", payload: { application_id: APP } })).kind).toBe("invalid");
    expect((await s.consumer.handle({ messageId: MSG(2), type: "brand_application.approved", payload: { application_id: APP } })).kind).toBe("invalid");
    expect((await s.consumer.handle({ messageId: MSG(3), type: "brand_application.approved", payload: {} })).kind).toBe("invalid");
    expect(await s.stores.all()).toHaveLength(0);
  });

  it("a name conflict parks the application as store_name_conflict and sends no approval notice", async () => {
    const s = setup();
    s.applications.payloads.set(APP, payload());
    s.applications.payloads.set(APP2, payload({ application_id: APP2, applicant_seller_user_id: USER2, brand_name_ar: null }));
    await s.consumer.handle(approved(1));
    const r = await s.consumer.handle({ messageId: MSG(2), type: "brand_application.approved", payload: { application_id: APP2 } });
    expect(r).toEqual({ kind: "provisioning_failed", code: "store_name_conflict" });
    expect(s.notifier.sent.filter((n) => n.userId === USER2)).toHaveLength(0);
    expect(s.conflicts.entries).toHaveLength(1);
  });
});
