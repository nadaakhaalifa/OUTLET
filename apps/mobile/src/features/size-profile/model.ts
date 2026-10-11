/** Size profile and guided measurement (spec §10). Pure model, port and in-memory fake; no UI imports. */
import { PortError, type PortFailure } from "../worlds/model";

export { PortError };
export type { PortFailure };

/** Measurement keys, in guided order. All lengths in cm except weight (kg). */
export const MEASUREMENT_KEYS = [
  "height", "weight", "bust", "underBust", "waist", "highHip", "hip", "shoulders", "sleeve", "inseam", "thigh", "neck", "footLength", "footWidth", "wrist",
] as const;
export type MeasurementKey = (typeof MEASUREMENT_KEYS)[number];

/** Plausible ranges in tenths (cm*10 or kg*10). Integers only; no float arithmetic on stored values. */
export const MEASUREMENT_RANGES: Readonly<Record<MeasurementKey, { readonly min: number; readonly max: number }>> = {
  height: { min: 500, max: 2500 },
  weight: { min: 20, max: 3000 },
  bust: { min: 400, max: 2500 },
  underBust: { min: 400, max: 2000 },
  waist: { min: 300, max: 2500 },
  highHip: { min: 400, max: 2500 },
  hip: { min: 400, max: 2500 },
  shoulders: { min: 200, max: 800 },
  sleeve: { min: 200, max: 1000 },
  inseam: { min: 200, max: 1300 },
  thigh: { min: 200, max: 1200 },
  neck: { min: 150, max: 700 },
  footLength: { min: 80, max: 400 },
  footWidth: { min: 40, max: 200 },
  wrist: { min: 80, max: 350 },
};

export type ProfileKind = "me" | "partner" | "child";
export type FitPreference = "snug" | "regular" | "loose";
export const FIT_PREFERENCES: readonly FitPreference[] = ["snug", "regular", "loose"];

/** Children's profiles hold measurements and a nickname only; there is deliberately no DOB or photo field. */
export interface SizeProfile {
  readonly id: string;
  readonly kind: ProfileKind;
  readonly label: string;
  readonly fitPreference: FitPreference;
  readonly modestFit: boolean;
  /** Tenths of cm (kg for weight). Missing keys were skipped. */
  readonly measurements: Readonly<Partial<Record<MeasurementKey, number>>>;
  readonly usualSize: string | null;
}

export type NewProfile = Omit<SizeProfile, "id">;

export interface SizeProfilePort {
  list(): Promise<readonly SizeProfile[]>;
  save(profile: NewProfile | SizeProfile): Promise<SizeProfile>;
  remove(id: string): Promise<void>;
}

export type MeasurementError = "empty" | "notNumber" | "tooLow" | "tooHigh";
export type MeasurementResult =
  | { readonly ok: true; readonly tenths: number }
  | { readonly ok: false; readonly error: MeasurementError };

const EASTERN = "٠١٢٣٤٥٦٧٨٩";

/** Accepts Eastern Arabic digits, "," and "٫" decimals. At most one decimal place. */
export function parseMeasurement(raw: string): MeasurementResult | { readonly ok: false; readonly error: "empty" | "notNumber" } {
  const ascii = raw
    .trim()
    .replace(/[٠-٩]/g, (d) => String(EASTERN.indexOf(d)))
    .replace(/[٫,]/g, ".");
  if (ascii.length === 0) return { ok: false, error: "empty" };
  const m = /^(\d{1,4})(?:\.(\d))?$/.exec(ascii);
  if (m === null) return { ok: false, error: "notNumber" };
  return { ok: true, tenths: Number(m[1]) * 10 + Number(m[2] ?? "0") };
}

export function validateMeasurement(key: MeasurementKey, raw: string): MeasurementResult {
  const p = parseMeasurement(raw);
  if (!p.ok) return p;
  const r = MEASUREMENT_RANGES[key];
  if (p.tenths < r.min) return { ok: false, error: "tooLow" };
  if (p.tenths > r.max) return { ok: false, error: "tooHigh" };
  return p;
}

/** Cross-field plausibility on already-validated values, e.g. under-bust cannot exceed bust. */
export type ProfileIssue = "underBustAboveBust" | "highHipAboveHip" | "footWidthAboveLength";
export function crossChecks(m: Readonly<Partial<Record<MeasurementKey, number>>>): readonly ProfileIssue[] {
  const issues: ProfileIssue[] = [];
  if (m.underBust !== undefined && m.bust !== undefined && m.underBust > m.bust) issues.push("underBustAboveBust");
  if (m.highHip !== undefined && m.hip !== undefined && m.highHip > m.hip) issues.push("highHipAboveHip");
  if (m.footWidth !== undefined && m.footLength !== undefined && m.footWidth > m.footLength) issues.push("footWidthAboveLength");
  return issues;
}

export interface WizardState {
  readonly index: number;
  readonly values: Readonly<Partial<Record<MeasurementKey, string>>>;
  readonly errors: Readonly<Partial<Record<MeasurementKey, MeasurementError>>>;
}

export function initialWizard(): WizardState {
  return { index: 0, values: {}, errors: {} };
}

export function currentKey(s: WizardState): MeasurementKey | null {
  return MEASUREMENT_KEYS[s.index] ?? null;
}

export function enterValue(s: WizardState, key: MeasurementKey, raw: string): WizardState {
  const errors: Partial<Record<MeasurementKey, MeasurementError>> = { ...s.errors };
  delete errors[key];
  return { ...s, values: { ...s.values, [key]: raw }, errors };
}

/** Empty is a skip. A non-empty invalid value blocks advancing and records the error. */
export function advance(s: WizardState): WizardState {
  const key = currentKey(s);
  if (key === null) return s;
  const raw = s.values[key] ?? "";
  if (raw.trim().length > 0) {
    const r = validateMeasurement(key, raw);
    if (!r.ok) return { ...s, errors: { ...s.errors, [key]: r.error } };
  }
  return { ...s, index: s.index + 1 };
}

export function back(s: WizardState): WizardState {
  return { ...s, index: Math.max(0, s.index - 1) };
}

export function isFinished(s: WizardState): boolean {
  return s.index >= MEASUREMENT_KEYS.length;
}

export function collectMeasurements(s: WizardState): { readonly measurements: Partial<Record<MeasurementKey, number>>; readonly issues: readonly ProfileIssue[] } {
  const out: Partial<Record<MeasurementKey, number>> = {};
  for (const key of MEASUREMENT_KEYS) {
    const raw = s.values[key];
    if (raw === undefined || raw.trim().length === 0) continue;
    const r = validateMeasurement(key, raw);
    if (r.ok) out[key] = r.tenths;
  }
  return { measurements: out, issues: crossChecks(out) };
}

export type QuickStartError = "heightInvalid" | "weightInvalid" | "sizeRequired";
export function quickStart(input: { heightRaw: string; weightRaw: string; usualSize: string }): { readonly errors: readonly QuickStartError[]; readonly measurements: Partial<Record<MeasurementKey, number>> } {
  const errors: QuickStartError[] = [];
  const measurements: Partial<Record<MeasurementKey, number>> = {};
  const h = validateMeasurement("height", input.heightRaw);
  if (h.ok) measurements.height = h.tenths; else errors.push("heightInvalid");
  if (input.weightRaw.trim().length > 0) {
    const w = validateMeasurement("weight", input.weightRaw);
    if (w.ok) measurements.weight = w.tenths; else errors.push("weightInvalid");
  }
  if (input.usualSize.trim().length === 0) errors.push("sizeRequired");
  return { errors, measurements };
}

export function isMeasuredLater(p: SizeProfile): boolean {
  return Object.keys(p.measurements).length === 0;
}

/** "Measure later" creates a profile with no measurements; recommendations then say so honestly. */
export function measureLaterProfile(label: string, kind: ProfileKind): NewProfile {
  return { kind, label: label.trim(), fitPreference: "regular", modestFit: false, measurements: {}, usualSize: null };
}

export function validateLabel(label: string): "required" | "tooLong" | null {
  const t = label.trim();
  if (t.length === 0) return "required";
  return t.length > 30 ? "tooLong" : null;
}

export type ProfilesScreenState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly offline: boolean }
  | { readonly status: "ready"; readonly profiles: readonly SizeProfile[] };

export function profilesFailureState(e: unknown): ProfilesScreenState {
  return { status: "error", offline: e instanceof PortError && e.kind === "offline" };
}

/** Format tenths as "74.5" / "74" for display or editing (locale digits applied by the caller). */
export function formatTenths(t: number): string {
  const whole = Math.floor(t / 10);
  const frac = t % 10;
  return frac === 0 ? String(whole) : `${whole}.${frac}`;
}

/* ---- in-memory fakes (development and tests only; synthetic data) ---- */

export class InMemorySizeProfilePort implements SizeProfilePort {
  private profiles: SizeProfile[];
  private seq = 1;
  constructor(initial: readonly SizeProfile[] = [], private failure: PortFailure | null = null) {
    this.profiles = [...initial];
  }
  setFailure(f: PortFailure | null): void {
    this.failure = f;
  }
  private check(): void {
    if (this.failure !== null) throw new PortError(this.failure);
  }
  async list(): Promise<readonly SizeProfile[]> {
    this.check();
    return this.profiles;
  }
  async save(p: NewProfile | SizeProfile): Promise<SizeProfile> {
    this.check();
    if ("id" in p) {
      this.profiles = this.profiles.map((x) => (x.id === p.id ? p : x));
      return p;
    }
    const created: SizeProfile = { ...p, id: `sp${this.seq++}` };
    this.profiles = [...this.profiles, created];
    return created;
  }
  async remove(id: string): Promise<void> {
    this.check();
    this.profiles = this.profiles.filter((p) => p.id !== id);
  }
}
