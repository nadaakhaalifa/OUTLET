import { useMemo } from "react";
import { PrivacyCenterScreen } from "../features/privacy-center/PrivacyCenterScreen";
import { PortError, type DeletionState, type PrivacyPort, type PrivacySnapshot } from "../features/privacy-center/model";
import { CONSENT_PURPOSES, DEFAULT_COOLING_DAYS, evaluateDeletionEligibility, type ConsentPurpose } from "../workspace";
import { GuestGate } from "../features/me/GuestGate";
import { GuestPrivacyPanel } from "../features/privacy-center/GuestPrivacyPanel";
import { useServices, type AppServices } from "../state/services";

/** Adapts the real consent controller and API port to the feature's PrivacyPort. */
function createPort(services: AppServices): PrivacyPort {
  let exportStatus: PrivacySnapshot["export"] = { state: "none" };
  let cooling: DeletionState | null = null;
  return {
    async load() {
      const [snap, sessions] = await Promise.all([services.api.getDeletionSnapshot(), services.api.listSessions()]);
      if (!snap.ok) throw new PortError(snap.error.code === "network" ? "offline" : "failed");
      const e = evaluateDeletionEligibility(snap.value);
      const deletion: DeletionState =
        cooling ??
        (e.eligible
          ? { state: "eligible", coolingDays: DEFAULT_COOLING_DAYS, forfeiture: e.forfeitureWarning?.balanceMinor ?? null }
          : { state: "blocked", blockers: e.blockers });
      const view = services.consent.view();
      return {
        consents: CONSENT_PURPOSES.map((p) => ({ purpose: p, granted: view[p] })),
        export: exportStatus,
        deletion,
        sessions: sessions.ok ? sessions.value.map((s) => ({ id: s.id, deviceLabel: s.deviceLabel, lastUsedAt: s.lastUsedAt, current: s.current })) : [],
        pendingSync: services.consent.pendingCount,
      };
    },
    async setConsent(purpose, granted) {
      await services.consent.set(purpose as ConsentPurpose, granted, "settings_toggle");
    },
    async requestExport(idempotencyKey) {
      const r = await services.api.requestDataExport({ idempotencyKey });
      if (!r.ok) throw new PortError("failed");
      exportStatus = { state: "requested", dueAt: r.value.dueAt };
      return exportStatus;
    },
    async requestDeletion(input) {
      const r = await services.api.requestAccountDeletion(input);
      if (!r.ok) throw new PortError("failed");
      cooling = { state: "cooling", endsAt: r.value.coolingEndsAt };
      return cooling;
    },
    async cancelDeletion() {
      const r = await services.api.cancelAccountDeletion();
      if (!r.ok) throw new PortError("failed");
      cooling = null;
      const snap = await services.api.getDeletionSnapshot();
      const e = snap.ok ? evaluateDeletionEligibility(snap.value) : null;
      return e !== null && !e.eligible
        ? { state: "blocked", blockers: e.blockers }
        : { state: "eligible", coolingDays: DEFAULT_COOLING_DAYS, forfeiture: e !== null && e.eligible ? e.forfeitureWarning?.balanceMinor ?? null : null };
    },
  };
}

export default function PrivacyCenter() {
  const services = useServices();
  const port = useMemo(() => createPort(services), [services]);
  return <GuestGate feature="guestPrivacy">{(guest) => (guest ? <GuestPrivacyPanel /> : <PrivacyCenterScreen port={port} />)}</GuestGate>;
}
