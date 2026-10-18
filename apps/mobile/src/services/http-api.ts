import { ApiError, dataOf, type OutletClient } from "./api-client";
import { toPortError } from "./wire";
import type { AgeGatePort, AgeGateRequest, AgeGateResponse } from "../api/age-gate";
import type {
  ApiResult, ApiSession, ConsentChange, DeletionRequested, ExportRequested, OtpRequested, OutletApi, VerifiedLogin,
} from "../api/port";
import type { CivilDate, DeletionSnapshot, PrivacyClock } from "../workspace";
import { NetworkError, TimeoutError } from "./api-client";

const fail = <T>(code: Extract<ApiResult<T>, { ok: false }>["error"]["code"], retryAfterSeconds?: number): ApiResult<T> =>
  ({ ok: false, error: retryAfterSeconds !== undefined ? { code, retryAfterSeconds } : { code } });

function mapError<T>(e: unknown): ApiResult<T> {
  if (e instanceof NetworkError || e instanceof TimeoutError) return fail("network");
  if (e instanceof ApiError) {
    const retry = e.retryAfterSeconds ?? undefined;
    switch (e.code) {
      case "otp_invalid": return fail("invalid_code");
      case "otp_expired": return fail("code_expired");
      case "country_not_allowed": return fail("country_not_supported");
      case "deletion_blocked": return fail("deletion_blocked");
      default:
    }
    if (e.status === 429) return fail("rate_limited", retry);
    if (e.status === 401) return fail("unauthenticated");
    if (e.status === 403 && (e.code ?? "").includes("age")) return fail("age_not_eligible");
    return fail("unavailable");
  }
  throw toPortError(e);
}

const pad = (n: number, w: number): string => String(n).padStart(w, "0");
const isoDate = (d: CivilDate): string => `${pad(d.year, 4)}-${pad(d.month, 2)}-${pad(d.day, 2)}`;

/** OutletApi over the generated client (POST /v1/auth/*, /v1/me/privacy/*, /v1/me/sessions). */
export class HttpOutletApi implements OutletApi {
  private challengeByPhone = new Map<string, string>();
  constructor(
    private readonly client: OutletClient,
    private readonly installId: () => Promise<string>,
    private readonly platform: "ios" | "android",
    private readonly clock: PrivacyClock,
  ) {}

  async requestOtp(input: { phoneE164: string; locale: "ar" | "en"; idempotencyKey: string }): Promise<ApiResult<OtpRequested>> {
    try {
      const r = dataOf(
        await this.client.requestOtp({ body: { phone_e164: input.phoneE164, locale: input.locale === "ar" ? "ar-EG" : "en" } }, { idempotencyKey: input.idempotencyKey }),
      );
      this.challengeByPhone.set(input.phoneE164, r.challenge_id);
      // The wire reports attempts_remaining, not sends so far (gap): derive the count from the 3-per-15-min policy.
      return { ok: true, value: { sendsSoFar: Math.max(1, 3 - (r.attempts_remaining ?? 2)) } };
    } catch (e) {
      return mapError(e);
    }
  }

  async verifyOtp(input: { phoneE164: string; code: string; mode?: "existing_only" }): Promise<ApiResult<VerifiedLogin>> {
    const challenge = this.challengeByPhone.get(input.phoneE164);
    if (challenge === undefined) return fail("code_expired");
    try {
      const t = dataOf(
        await this.client.verifyOtp({ body: { challenge_id: challenge, code: input.code, device: { platform: this.platform, install_id: await this.installId() }, ...(input.mode !== undefined ? { mode: input.mode } : {}) } }),
      );
      return {
        ok: true,
        value: {
          isNewAccount: t.is_new_account === true,
          tokens: { accessToken: t.access_token, refreshToken: t.refresh_token, accessExpiresAtMs: Date.parse(t.access_expires_at) },
        },
      };
    } catch (e) {
      if (input.mode === "existing_only" && e instanceof ApiError && e.status === 404) {
        // 404 no_account: nothing was created. Any other 404 (feature blocked) is "not available", never create mode.
        return fail(e.code === "no_account" ? "no_account" : "sign_in_unavailable");
      }
      return mapError(e);
    }
  }

  async submitAge(input: { dob: CivilDate; attestedAtLeast18: true }): Promise<ApiResult<void>> {
    try {
      dataOf(await this.client.submitAgeAttestation({ body: { date_of_birth: isoDate(input.dob), attests_18_or_older: true, device_install_id: await this.installId() } }));
      return { ok: true, value: undefined };
    } catch (e) {
      return mapError(e);
    }
  }

  async recordConsent(change: ConsentChange): Promise<ApiResult<void>> {
    try {
      dataOf(await this.client.updateConsents({ body: { changes: [{ purpose: change.purpose, granted: change.granted, policy_version: String(change.version) }] } }));
      return { ok: true, value: undefined };
    } catch (e) {
      return mapError(e);
    }
  }

  async getDeletionSnapshot(): Promise<ApiResult<DeletionSnapshot>> {
    try {
      let openOrders = 0;
      let openReturns = 0;
      let openDisputes = 0;
      try {
        for (const b of dataOf(await this.client.getAccountDeletion()).blockers) {
          if (b.code === "open_order") openOrders++;
          else if (b.code === "open_return") openReturns++;
          else if (b.code === "open_dispute") openDisputes++;
        }
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) throw e;
      }
      const wallet = dataOf(await this.client.getWallet());
      return { ok: true, value: { openOrders, openReturns, openDisputes, storeCreditMinor: BigInt(wallet.total.amount) } };
    } catch (e) {
      return mapError(e);
    }
  }

  async requestDataExport(input: { idempotencyKey: string }): Promise<ApiResult<ExportRequested>> {
    try {
      const r = dataOf(await this.client.requestDataExport({ body: {} }, { idempotencyKey: input.idempotencyKey }));
      return { ok: true, value: { requestId: r.id, dueAt: r.ready_target_at ?? r.requested_at } };
    } catch (e) {
      return mapError(e);
    }
  }

  /** The acknowledgement travels on the wire (409 forfeiture_acknowledgement_required without it). */
  async requestAccountDeletion(input: { acknowledgedForfeiture: boolean; idempotencyKey: string }): Promise<ApiResult<DeletionRequested>> {
    try {
      const r = dataOf(await this.client.requestAccountDeletion({ body: { acknowledge_credit_forfeiture: input.acknowledgedForfeiture } }, { idempotencyKey: input.idempotencyKey }));
      return {
        ok: true,
        value: {
          coolingEndsAt: r.cooling_off_ends_at ?? new Date(this.clock.now().getTime() + 14 * 86_400_000).toISOString(),
          forfeitedStoreCreditMinor: r.store_credit_balance !== undefined && r.store_credit_balance !== null ? BigInt(r.store_credit_balance.amount) : 0n,
        },
      };
    } catch (e) {
      return mapError(e);
    }
  }

  async cancelAccountDeletion(): Promise<ApiResult<void>> {
    try {
      await this.client.cancelAccountDeletion();
      return { ok: true, value: undefined };
    } catch (e) {
      return mapError(e);
    }
  }

  async listSessions(): Promise<ApiResult<readonly ApiSession[]>> {
    try {
      const r = dataOf(await this.client.listSessions());
      return { ok: true, value: r.items.map((s) => ({ id: s.id, deviceLabel: s.device_label ?? s.platform, lastUsedAt: s.last_seen_at, current: s.current })) };
    } catch (e) {
      return mapError(e);
    }
  }
}

/** POST /v1/auth/age-gate. 403 with `blocked_until` is the soft-block; anything unexpected fails closed as unavailable. */
export class HttpAgeGate implements AgeGatePort {
  constructor(private readonly client: OutletClient) {}

  async check(request: AgeGateRequest): Promise<AgeGateResponse> {
    try {
      dataOf(await this.client.submitAgeGate({ body: { dob: isoDate(request.dob), device_id_hash: request.deviceIdHash } }));
      return { ok: true, allowed: true };
    } catch (e) {
      if (e instanceof ApiError) {
        const until = e.problem["blocked_until"];
        if (e.status === 403 && typeof until === "string") return { ok: true, allowed: false, blockedUntil: until };
        if (e.status === 429) return { ok: false, error: "rate_limited" };
      }
      if (e instanceof NetworkError || e instanceof TimeoutError) return { ok: false, error: "network" };
      return { ok: false, error: "unavailable" };
    }
  }
}
