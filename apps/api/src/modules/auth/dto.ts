import { z } from "zod";
import { pageOf } from "../../platform/pagination.js";

const Iso = z.iso.datetime();

export const DeviceRegisterBody = z.strictObject({ install_id: z.uuid(), platform: z.enum(["web", "ios", "android"]), attestation: z.string().min(1).max(4096).optional() });
export const DeviceRegistered = z.strictObject({ device_id: z.uuid() });

export const OtpRequestBody = z.strictObject({
  phone_e164: z.string().regex(/^\+[1-9][0-9]{7,14}$/),
  channel: z.enum(["sms", "whatsapp"]),
  purpose: z.enum(["sign_in", "register", "step_up"]),
});
export const OtpChallenge = z.strictObject({ challenge_id: z.uuid(), expires_at: Iso, resend_after_s: z.number().int().min(1), channel: z.literal("sms") });

/** Contract OtpVerifyInput plus `phone_e164` (auth-core binds a challenge to the phone's blind index) and `dob` (new accounts; the age-gate route is not built). */
export const OtpVerifyBody = z.strictObject({
  challenge_id: z.uuid(),
  phone_e164: z.string().regex(/^\+[1-9][0-9]{7,14}$/),
  code: z.string().regex(/^[0-9]{6}$/),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const TokenPair = z.strictObject({
  access_token: z.string().max(4096),
  access_expires_at: Iso,
  refresh_token: z.string().max(500),
  refresh_expires_at: Iso,
  token_type: z.literal("Bearer"),
  amr: z.array(z.string().max(50)).max(10),
  user_id: z.uuid(),
  is_new_user: z.boolean(),
});
export type TokenPair = z.infer<typeof TokenPair>;

/** The refresh token comes from the body (BFF) or, when omitted, from the HttpOnly cookie set at sign-in. */
export const RefreshBody = z.strictObject({ refresh_token: z.string().min(1).max(500).optional() });

export const FederatedBody = z.strictObject({ id_token: z.string().min(1).max(8192), nonce: z.string().min(1).max(500) });

export const SessionFamily = z.strictObject({
  id: z.uuid(),
  device_id: z.uuid(),
  platform: z.string().max(50),
  ua_family: z.string().max(500).nullable(),
  amr: z.array(z.string().max(50)).max(10),
  created_at: Iso,
  last_seen_at: Iso.nullable(),
  current: z.boolean(),
});
export const SessionFamilyPage = pageOf(SessionFamily);
export type SessionFamilyPage = z.infer<typeof SessionFamilyPage>;

export const SessionId = z.strictObject({ session_family_id: z.uuid() });

export const PasskeyOptionsBody = z.strictObject({ purpose: z.enum(["sign_in", "step_up", "register"]) });
export const PasskeyOptions = z.strictObject({ challenge_id: z.uuid(), public_key: z.record(z.string(), z.unknown()), expires_at: Iso });

const B64 = z.string().min(1).max(8192).regex(/^[A-Za-z0-9_-]+$/);
export const RegistrationCredential = z.looseObject({
  id: B64,
  rawId: B64,
  type: z.literal("public-key"),
  response: z.looseObject({ clientDataJSON: B64, attestationObject: B64 }),
  clientExtensionResults: z.record(z.string(), z.unknown()),
});
export const AssertionCredential = z.looseObject({
  id: B64,
  type: z.literal("public-key"),
  response: z.looseObject({ clientDataJSON: B64, authenticatorData: B64, signature: B64 }),
});
export const PasskeyRegisterVerifyBody = z.strictObject({ challenge_id: z.uuid(), credential: RegistrationCredential });
export const PasskeyAssertVerifyBody = z.strictObject({ challenge_id: z.uuid(), credential: AssertionCredential });
export const PasskeyCredential = z.strictObject({
  id: z.uuid(),
  aaguid: z.uuid().nullable(),
  transports: z.array(z.string().max(50)).max(10),
  backup_eligible: z.boolean(),
  created_at: Iso,
  last_used_at: Iso.nullable(),
});

export const PasskeyId = z.strictObject({ passkey_id: z.uuid() });
export const PasskeyPage = pageOf(PasskeyCredential);
export type PasskeyPage = z.infer<typeof PasskeyPage>;
