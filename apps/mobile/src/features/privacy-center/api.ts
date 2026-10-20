import { ApiError, dataOf, type schemas } from "../../services/api-client";
import { guard, money, type AdapterContext } from "../../services/wire";
import type { Blocker, DeletionBlockerKind, DeletionState, ExportStatus, PrivacyPort, PrivacySnapshot } from "./model";

const BLOCKER: Readonly<Record<string, DeletionBlockerKind | undefined>> = {
  open_order: "open_orders", open_return: "open_returns", open_dispute: "open_disputes",
};
const COOLING_DAYS = 14;
type ConsentPurpose = schemas.ConsentUpdate["changes"][number]["purpose"];

export function mapDeletion(d: schemas.PrivacyDeletion): DeletionState {
  if (d.status === "cooling_off") return { state: "cooling", endsAt: d.cooling_off_ends_at ?? "" };
  const counts = new Map<DeletionBlockerKind, number>();
  for (const b of d.blockers) {
    const k = BLOCKER[b.code];
    if (k !== undefined) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  if (d.status === "blocked" || counts.size > 0) {
    const blockers: Blocker[] = [...counts.entries()].map(([kind, count]) => ({ kind, count }));
    return { state: "blocked", blockers };
  }
  const bal = d.store_credit_balance !== undefined && d.store_credit_balance !== null ? money(d.store_credit_balance) : 0n;
  return { state: "eligible", coolingDays: COOLING_DAYS, forfeiture: bal > 0n ? bal : null };
}

export function mapExport(e: schemas.PrivacyExport): ExportStatus {
  switch (e.status) {
    case "queued":
    case "building":
      return { state: "requested", dueAt: e.ready_target_at ?? e.requested_at };
    case "ready":
      return { state: "ready", expiresAt: e.download_expires_at ?? "", url: e.download_url ?? null };
    case "expired":
    case "failed":
      return { state: "none" };
  }
}

/** /v1/me/privacy/*. Export status comes from GET /export/latest (404 means none yet). */
export class ApiPrivacyPort implements PrivacyPort {
  private lastExport: ExportStatus = { state: "none" };
  private versions = new Map<string, string>();
  constructor(private readonly ctx: AdapterContext) {}

  private async deletion(): Promise<DeletionState> {
    try {
      return mapDeletion(dataOf(await this.ctx.client.getAccountDeletion()));
    } catch (e) {
      // 404 = no deletion request exists: the account is eligible (pre-request blockers are a gap).
      if (e instanceof ApiError && e.status === 404) return { state: "eligible", coolingDays: COOLING_DAYS, forfeiture: null };
      throw e;
    }
  }

  private async latestExport(): Promise<ExportStatus> {
    try {
      this.lastExport = mapExport(dataOf(await this.ctx.client.getLatestDataExport()));
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    }
    return this.lastExport;
  }

  load(): Promise<PrivacySnapshot> {
    return guard(async () => {
      const [consents, deletion, sessions] = await Promise.all([
        this.ctx.client.getConsents().then(dataOf),
        this.deletion(),
        this.ctx.client.listSessions().then(dataOf),
      ]);
      this.versions = new Map(consents.consents.map((c) => [c.purpose, c.policy_version]));
      return {
        consents: consents.consents.map((c) => ({ purpose: c.purpose, granted: c.granted })),
        export: await this.latestExport(),
        deletion,
        sessions: sessions.items.map((s) => ({ id: s.id, deviceLabel: s.device_label ?? s.platform, lastUsedAt: s.last_seen_at, current: s.current })),
        pendingSync: 0,
      };
    });
  }

  setConsent(purpose: string, granted: boolean): Promise<void> {
    return guard(async () => {
      dataOf(
        await this.ctx.client.updateConsents({
          body: { changes: [{ purpose: purpose as ConsentPurpose, granted, policy_version: this.versions.get(purpose) ?? "1" }] },
        }),
      );
    });
  }

  requestExport(idempotencyKey: string): Promise<ExportStatus> {
    return guard(async () => {
      this.lastExport = mapExport(dataOf(await this.ctx.client.requestDataExport({ body: {} }, { idempotencyKey })));
      return this.lastExport;
    });
  }

  /** The acknowledgement travels on the wire: without it the server answers 409 when store credit would be forfeited. */
  requestDeletion(input: { acknowledgedForfeiture: boolean; idempotencyKey: string }): Promise<DeletionState> {
    return guard(async () =>
      mapDeletion(
        dataOf(await this.ctx.client.requestAccountDeletion({ body: { acknowledge_credit_forfeiture: input.acknowledgedForfeiture } }, { idempotencyKey: input.idempotencyKey })),
      ),
    );
  }

  cancelDeletion(): Promise<DeletionState> {
    return guard(async () => {
      await this.ctx.client.cancelAccountDeletion();
      return this.deletion();
    });
  }

  revokeSession(id: string): Promise<void> {
    return guard(async () => {
      dataOf(await this.ctx.client.revokeSession({ path: { sessionId: id } }));
    });
  }
}

