import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * One row per directory under `src/modules`. `composed` modules boot in production with Postgres
 * stores and Unconfigured providers. `blocked` modules cannot be composed without changing the
 * module itself; they are left out of the production module graph and reported by /v1/ready.
 * A registry test fails when a new module directory has no row (ADR-0029).
 */
export type ModuleBinding =
  | { readonly status: "composed" }
  | { readonly status: "blocked"; readonly reason: string };

const DEV_ONLY = "forRoot refuses any non in-memory-dev config and wires in-memory ports that have no Postgres adapter";

export const MODULE_BINDINGS: Readonly<Record<string, ModuleBinding>> = {
  auth: {
    status: "blocked",
    reason: `${DEV_ONLY}: no Kysely adapters exist for users, sessions, OTP challenges, passkeys or age-gate rows, and tokens come from DevTokenService. All authenticated routes answer 401 (fail closed)`,
  },
  privacy: { status: "blocked", reason: `${DEV_ONLY}: Kysely consent, request and breach repositories exist and are options, but the blockers (FakeBlockers), exporters (FakeExporter), object store and outbox are built in forRoot as in-memory fakes` },
  catalog: { status: "blocked", reason: `${DEV_ONLY}: Kysely product repositories exist but stock, prices, stores, size charts, media, uploads and events are dev fixtures` },
  "price-integrity": { status: "blocked", reason: `${DEV_ONLY}: persistence option exists but forRoot throws before reading it` },
  wishlists: { status: "blocked", reason: `${DEV_ONLY}: repository option exists but the catalog read, owner profiles and event log are in-memory` },
  sizing: { status: "blocked", reason: `${DEV_ONLY}: Kysely repositories are an option, but forRoot builds DevAesGcmFieldCipher for P3 measurements, plus in-memory measurements consent, fit catalog, order lines and event log` },
  notifications: { status: "blocked", reason: `${DEV_ONLY}: Kysely repositories are an option, but every channel provider is a FakeProvider built in forRoot (push, WhatsApp, SMS, email)` },
  admin: { status: "composed" },
  ads: { status: "composed" },
  budget: { status: "composed" },
  cart: { status: "composed" },
  checkout: { status: "composed" },
  "courier-aramex": { status: "composed" },
  drops: { status: "composed" },
  fulfillment: { status: "composed" },
  "gift-cards": { status: "composed" },
  history: { status: "composed" },
  "hub-consolidation": { status: "composed" },
  inventory: { status: "composed" },
  ledger: { status: "composed" },
  "llm-gateway": { status: "composed" },
  orders: { status: "composed" },
  payments: { status: "composed" },
  payouts: { status: "composed" },
  "price-crawler": { status: "composed" },
  promotions: { status: "composed" },
  recommendations: { status: "composed" },
  reconciliation: { status: "composed" },
  referrals: { status: "composed" },
  refunds: { status: "composed" },
  "resale-lane": { status: "composed" },
  retention: { status: "composed" },
  returns: { status: "composed" },
  reviews: { status: "composed" },
  rewards: { status: "composed" },
  search: { status: "composed" },
  "seller-analytics": { status: "composed" },
  "store-credit": { status: "composed" },
  stores: { status: "composed" },
  stylist: { status: "composed" },
  subscriptions: { status: "composed" },
  "tax-eta": { status: "composed" },
  "waiting-room": { status: "composed" },
};

/** Module directories on disk that have no binding row (the registry test asserts this is empty). */
export function unboundModuleDirs(modulesDir: string): readonly string[] {
  return readdirSync(modulesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && MODULE_BINDINGS[d.name] === undefined)
    .map((d) => d.name)
    .sort();
}

export function modulesDirOf(srcDir: string): string {
  return join(srcDir, "modules");
}
