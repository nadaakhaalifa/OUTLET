import { normalizeMeasurements, type FitPreference, type MeasurementError, type Measurements } from "../domain/bridge";
import type { Clock, IdGenerator } from "../../../platform/ports";
import type {
  MeasurementsConsentPort,
  Page,
  ProfileKind,
  ProfileRecord,
  SizeProfileRepository,
  SizingEventPublisher,
  FeedbackRepository,
} from "../domain/ports";
import type { ProfileCodec, ProfileView, UsualSize } from "./codec";

export const MAX_PROFILES_PER_USER = 6;
export const LABEL_MAX = 40;

export interface ProfileInput {
  readonly label: string;
  readonly kind: ProfileKind;
  readonly fitPreference?: FitPreference;
  readonly modestFit?: boolean;
  readonly measurements?: Readonly<Record<string, number>>;
  readonly usualSize?: UsualSize;
}

export interface ProfilePatch {
  readonly label?: string;
  readonly kind?: ProfileKind;
  readonly fitPreference?: FitPreference;
  readonly modestFit?: boolean;
  readonly measurements?: Readonly<Record<string, number>>;
  readonly usualSize?: UsualSize;
}

export type ProfileFailure =
  | { readonly kind: "label_invalid" }
  | { readonly kind: "limit_reached" }
  | { readonly kind: "consent_required" }
  | { readonly kind: "invalid_measurements"; readonly errors: readonly MeasurementError[] };

const hasControlChar = (t: string): boolean => [...t].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

function cleanLabel(raw: string): string | null {
  const t = raw.trim();
  if (t.length < 1 || t.length > LABEL_MAX || hasControlChar(t)) return null;
  return t;
}

export class CreateSizeProfile {
  constructor(
    private readonly repo: SizeProfileRepository,
    private readonly codec: ProfileCodec,
    private readonly consent: MeasurementsConsentPort,
    private readonly events: SizingEventPublisher,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(
    userId: string,
    input: ProfileInput,
  ): Promise<{ kind: "created"; view: ProfileView } | ProfileFailure> {
    const label = cleanLabel(input.label);
    if (label === null) return { kind: "label_invalid" };
    const hasP3 = input.measurements !== undefined || input.usualSize !== undefined;
    if (hasP3 && !(await this.consent.isGranted(userId))) return { kind: "consent_required" };
    let measurements: Measurements | null = null;
    if (input.measurements !== undefined) {
      const r = normalizeMeasurements(input.measurements);
      if (!r.ok) return { kind: "invalid_measurements", errors: r.errors };
      measurements = r.value;
    }
    if ((await this.repo.countLive(userId)) >= MAX_PROFILES_PER_USER) return { kind: "limit_reached" };
    const id = this.ids.uuidV7();
    const now = this.clock.nowMs();
    const sealed = await this.codec.seal(id, { label, measurements, usualSize: input.usualSize ?? null });
    const record: ProfileRecord = {
      id,
      userId,
      kind: input.kind,
      ...sealed,
      fitPreference: input.fitPreference ?? "regular",
      modestFit: input.modestFit ?? false,
      version: 1,
      createdAtMs: now,
      updatedAtMs: now,
    };
    await this.repo.insert(record);
    await this.events.publish({ type: "size_profile.updated", profileId: id, userId });
    return { kind: "created", view: await this.codec.open(record) };
  }
}

export class ListSizeProfiles {
  constructor(
    private readonly repo: SizeProfileRepository,
    private readonly codec: ProfileCodec,
  ) {}

  async execute(
    userId: string,
    page: { cursor: string | null; limit: number },
  ): Promise<{ kind: "ok"; items: ProfileView[]; nextCursor: string | null } | { kind: "invalid_cursor" }> {
    const r: Page<ProfileRecord> | "invalid_cursor" = await this.repo.list(userId, page);
    if (r === "invalid_cursor") return { kind: "invalid_cursor" };
    const items: ProfileView[] = [];
    for (const rec of r.items) items.push(await this.codec.open(rec));
    return { kind: "ok", items, nextCursor: r.nextCursor };
  }
}

export class GetSizeProfile {
  constructor(
    private readonly repo: SizeProfileRepository,
    private readonly codec: ProfileCodec,
  ) {}

  async execute(userId: string, profileId: string): Promise<ProfileView | null> {
    const rec = await this.repo.get(userId, profileId);
    return rec === null ? null : this.codec.open(rec);
  }
}

export class UpdateSizeProfile {
  constructor(
    private readonly repo: SizeProfileRepository,
    private readonly codec: ProfileCodec,
    private readonly consent: MeasurementsConsentPort,
    private readonly events: SizingEventPublisher,
    private readonly clock: Clock,
  ) {}

  /** `matches` receives the current decrypted view and decides whether If-Match is satisfied. */
  async execute(
    userId: string,
    profileId: string,
    patch: ProfilePatch,
    matches: (current: ProfileView) => boolean,
  ): Promise<
    | { kind: "updated"; view: ProfileView }
    | { kind: "not_found" }
    | { kind: "precondition_failed" }
    | ProfileFailure
  > {
    const rec = await this.repo.get(userId, profileId);
    if (rec === null) return { kind: "not_found" };
    const current = await this.codec.open(rec);
    if (!matches(current)) return { kind: "precondition_failed" };

    let label = current.label;
    if (patch.label !== undefined) {
      const l = cleanLabel(patch.label);
      if (l === null) return { kind: "label_invalid" };
      label = l;
    }
    if ((patch.measurements !== undefined || patch.usualSize !== undefined) && !(await this.consent.isGranted(userId))) {
      return { kind: "consent_required" };
    }
    let measurements = current.measurements;
    if (patch.measurements !== undefined) {
      const r = normalizeMeasurements(patch.measurements);
      if (!r.ok) return { kind: "invalid_measurements", errors: r.errors };
      measurements = r.value;
    }
    const usualSize = patch.usualSize ?? current.usualSize;
    const sealed = await this.codec.seal(profileId, { label, measurements, usualSize });
    const next: ProfileRecord = {
      ...rec,
      ...sealed,
      kind: patch.kind ?? rec.kind,
      fitPreference: patch.fitPreference ?? rec.fitPreference,
      modestFit: patch.modestFit ?? rec.modestFit,
      version: rec.version + 1,
      updatedAtMs: this.clock.nowMs(),
    };
    const r = await this.repo.update(next, rec.version);
    if (r === "not_found") return { kind: "not_found" };
    if (r === "conflict") return { kind: "precondition_failed" };
    await this.events.publish({ type: "size_profile.updated", profileId, userId });
    return { kind: "updated", view: await this.codec.open(next) };
  }
}

export class DeleteSizeProfile {
  constructor(
    private readonly repo: SizeProfileRepository,
    private readonly feedback: FeedbackRepository,
    private readonly events: SizingEventPublisher,
  ) {}

  async execute(userId: string, profileId: string): Promise<"deleted" | "not_found"> {
    const removed = await this.repo.delete(userId, profileId);
    if (!removed) return "not_found";
    // Aggregates stay (not personal). The link from the user's feedback to the profile is cut.
    await this.feedback.detachProfile(userId, profileId);
    await this.events.publish({ type: "size_profile.updated", profileId, userId });
    return "deleted";
  }
}
