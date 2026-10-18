import type { PrivacyClock as Clock } from "../workspace";
import type { DeletionSnapshot } from "../workspace";
import type {
  ApiResult,
  ConsentChange,
  DeletionRequested,
  ExportRequested,
  OutletApi,
  OtpRequested,
  VerifiedLogin,
  ApiSession,
} from "./port";

/**
 * DEVELOPMENT FIXTURE. Talks to nothing. It exists so the screens can be exercised before a backend
 * exists. It never produces plausible real data: tokens are obviously fake strings, balances are
 * zero, the session list is empty, and the only accepted OTP is the documented dev code.
 * Must never be wired into a release build (see api/index.ts).
 */
export const DEV_FIXTURE_LABEL = "DEV FIXTURE: not a real backend";
export const DEV_FIXTURE_OTP = "000000";
const DAY_MS = 86_400_000;
const EXPORT_TARGET_MS = 72 * 3_600_000;

function ok<T>(value: T): ApiResult<T> {
  return { ok: true, value };
}

export interface DevFakeOptions {
  readonly clock: Clock;
  /** Test hook: make every call fail like a dropped connection. */
  readonly offline?: boolean;
  readonly deletionSnapshot?: DeletionSnapshot;
}

export class DevFakeApi implements OutletApi {
  readonly label = DEV_FIXTURE_LABEL;
  readonly recordedConsents: ConsentChange[] = [];
  private sends = 0;

  constructor(private readonly options: DevFakeOptions) {}

  private offline<T>(): ApiResult<T> | null {
    return this.options.offline === true ? { ok: false, error: { code: "network" } } : null;
  }

  async requestOtp(): Promise<ApiResult<OtpRequested>> {
    const off = this.offline<OtpRequested>();
    if (off) return off;
    this.sends += 1;
    return ok({ sendsSoFar: this.sends });
  }

  async verifyOtp(input: { phoneE164: string; code: string; mode?: "existing_only" }): Promise<ApiResult<VerifiedLogin>> {
    const off = this.offline<VerifiedLogin>();
    if (off) return off;
    if (input.code !== DEV_FIXTURE_OTP) return { ok: false, error: { code: "invalid_code" } };
    // Fixture: in sign-in-only mode a number ending 9999 has no account; any other number is an existing account.
    if (input.mode === "existing_only" && input.phoneE164.endsWith("9999")) return { ok: false, error: { code: "no_account" } };
    return ok({
      isNewAccount: input.mode !== "existing_only",
      tokens: {
        accessToken: "DEV-FIXTURE-ACCESS-TOKEN-NOT-REAL",
        refreshToken: "DEV-FIXTURE-REFRESH-TOKEN-NOT-REAL",
        accessExpiresAtMs: this.options.clock.now().getTime() + 15 * 60_000,
      },
    });
  }

  async submitAge(): Promise<ApiResult<void>> {
    return this.offline<void>() ?? ok(undefined);
  }

  async recordConsent(change: ConsentChange): Promise<ApiResult<void>> {
    const off = this.offline<void>();
    if (off) return off;
    this.recordedConsents.push(change);
    return ok(undefined);
  }

  async getDeletionSnapshot(): Promise<ApiResult<DeletionSnapshot>> {
    const off = this.offline<DeletionSnapshot>();
    if (off) return off;
    return ok(
      this.options.deletionSnapshot ?? { openOrders: 0, openReturns: 0, openDisputes: 0, storeCreditMinor: 0n },
    );
  }

  async requestDataExport(): Promise<ApiResult<ExportRequested>> {
    const off = this.offline<ExportRequested>();
    if (off) return off;
    const now = this.options.clock.now().getTime();
    return ok({ requestId: "dev-fixture-export", dueAt: new Date(now + EXPORT_TARGET_MS).toISOString() });
  }

  async requestAccountDeletion(): Promise<ApiResult<DeletionRequested>> {
    const off = this.offline<DeletionRequested>();
    if (off) return off;
    const snap = this.options.deletionSnapshot;
    const now = this.options.clock.now().getTime();
    return ok({
      coolingEndsAt: new Date(now + 14 * DAY_MS).toISOString(),
      forfeitedStoreCreditMinor: snap?.storeCreditMinor ?? 0n,
    });
  }

  async cancelAccountDeletion(): Promise<ApiResult<void>> {
    return this.offline<void>() ?? ok(undefined);
  }

  async listSessions(): Promise<ApiResult<readonly ApiSession[]>> {
    return this.offline<readonly ApiSession[]>() ?? ok([]);
  }
}
