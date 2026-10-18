import { z } from "zod";

/**
 * Communication provider environment (ADR-0034). All optional: a channel is real only when its
 * required group is complete; a partial group is reported in `issues` and stays Unconfigured
 * (fail closed). Read from the same process env as config/env.ts, parsed here so the group logic
 * lives next to the adapters.
 */
const optStr = z.string().min(1).max(512).optional();
const sms = (p: "A" | "B") => ({
  [`SMS_${p}_ACCOUNT_SID`]: optStr,
  [`SMS_${p}_AUTH_TOKEN`]: optStr,
  [`SMS_${p}_FROM`]: optStr,
  [`SMS_${p}_MESSAGING_SERVICE_SID`]: optStr,
  [`SMS_${p}_VERIFY_SERVICE_SID`]: optStr,
  [`SMS_${p}_BASE_URL`]: z.string().url().optional(),
  [`SMS_${p}_VERIFY_BASE_URL`]: z.string().url().optional(),
});

const CommsEnvSchema = z.object({
  EXPO_PUSH_ENABLED: z.stringbool().optional(),
  EXPO_PUSH_ACCESS_TOKEN: optStr,
  ...sms("A"),
  ...sms("B"),
  SMS_STATUS_CALLBACK_URL: z.string().url().optional(),
  SMS_ALLOWED_PREFIXES: z.string().max(200).default("+20"),
  WHATSAPP_PHONE_NUMBER_ID: optStr,
  WHATSAPP_ACCESS_TOKEN: optStr,
  WHATSAPP_APP_SECRET: optStr,
  WHATSAPP_OTP_TEMPLATE: optStr,
  EMAIL_POSTMARK_SERVER_TOKEN: optStr,
  EMAIL_FROM: optStr,
  EMAIL_MESSAGE_STREAM: z.string().min(1).max(100).default("outbound"),
  EMAIL_WEBHOOK_SECRET: optStr,
});

export interface SmsVendorConfig {
  readonly vendor: "sms_a" | "sms_b";
  readonly baseUrl: string;
  readonly verifyBaseUrl: string;
  readonly accountSid: string;
  readonly authToken: string;
  readonly from: string | undefined;
  readonly messagingServiceSid: string | undefined;
  readonly verifyServiceSid: string | undefined;
  readonly statusCallbackUrl: string | undefined;
}
export interface CommsConfig {
  readonly push: { readonly accessToken: string | undefined } | null;
  readonly sms: readonly SmsVendorConfig[];
  readonly allowedPrefixes: readonly string[];
  readonly whatsapp: { readonly phoneNumberId: string; readonly accessToken: string; readonly appSecret: string; readonly otpTemplate: string | undefined } | null;
  readonly email: { readonly serverToken: string; readonly from: string; readonly messageStream: string; readonly webhookSecret: string | undefined } | null;
  /** Names of incomplete groups (names only, never values). */
  readonly issues: readonly string[];
}

export const COMMS_ENV_VARS = Object.keys(CommsEnvSchema.shape);

export function parseCommsConfig(env: Readonly<Record<string, string | undefined>>): CommsConfig {
  const pick: Record<string, string | undefined> = {};
  for (const k of COMMS_ENV_VARS) pick[k] = env[k] === "" ? undefined : env[k];
  const e = CommsEnvSchema.parse(pick) as Record<string, string | boolean | undefined>;
  const s = (k: string): string | undefined => (typeof e[k] === "string" ? (e[k] as string) : undefined);
  const issues: string[] = [];

  const smsList: SmsVendorConfig[] = [];
  for (const p of ["A", "B"] as const) {
    const sid = s(`SMS_${p}_ACCOUNT_SID`);
    const tok = s(`SMS_${p}_AUTH_TOKEN`);
    const from = s(`SMS_${p}_FROM`);
    const svc = s(`SMS_${p}_MESSAGING_SERVICE_SID`);
    const any = [sid, tok, from, svc].some((v) => v !== undefined);
    if (!any) continue;
    if (sid === undefined || tok === undefined || (from === undefined) === (svc === undefined)) {
      issues.push(`SMS_${p}: needs ACCOUNT_SID, AUTH_TOKEN and exactly one of FROM or MESSAGING_SERVICE_SID`);
      continue;
    }
    smsList.push({
      vendor: p === "A" ? "sms_a" : "sms_b",
      baseUrl: s(`SMS_${p}_BASE_URL`) ?? "https://api.twilio.com",
      verifyBaseUrl: s(`SMS_${p}_VERIFY_BASE_URL`) ?? "https://verify.twilio.com",
      accountSid: sid,
      authToken: tok,
      from,
      messagingServiceSid: svc,
      verifyServiceSid: s(`SMS_${p}_VERIFY_SERVICE_SID`),
      statusCallbackUrl: s("SMS_STATUS_CALLBACK_URL"),
    });
  }

  const waParts = [s("WHATSAPP_PHONE_NUMBER_ID"), s("WHATSAPP_ACCESS_TOKEN"), s("WHATSAPP_APP_SECRET")];
  let whatsapp: CommsConfig["whatsapp"] = null;
  if (waParts.some((v) => v !== undefined)) {
    const [id, tok, secret] = waParts;
    if (id === undefined || tok === undefined || secret === undefined) issues.push("WHATSAPP: needs PHONE_NUMBER_ID, ACCESS_TOKEN and APP_SECRET");
    else whatsapp = { phoneNumberId: id, accessToken: tok, appSecret: secret, otpTemplate: s("WHATSAPP_OTP_TEMPLATE") };
  }

  let email: CommsConfig["email"] = null;
  const tok = s("EMAIL_POSTMARK_SERVER_TOKEN");
  const from = s("EMAIL_FROM");
  if (tok !== undefined || from !== undefined) {
    if (tok === undefined || from === undefined) issues.push("EMAIL: needs POSTMARK_SERVER_TOKEN and FROM");
    else {
      email = { serverToken: tok, from, messageStream: s("EMAIL_MESSAGE_STREAM") ?? "outbound", webhookSecret: s("EMAIL_WEBHOOK_SECRET") };
      if (email.webhookSecret === undefined) issues.push("EMAIL: WEBHOOK_SECRET unset, bounce and complaint webhooks will be refused");
    }
  }

  return {
    push: e.EXPO_PUSH_ENABLED === true ? { accessToken: s("EXPO_PUSH_ACCESS_TOKEN") } : null,
    sms: smsList,
    allowedPrefixes: (s("SMS_ALLOWED_PREFIXES") ?? "+20").split(",").map((x) => x.trim()).filter((x) => /^\+\d{1,4}$/.test(x)),
    whatsapp,
    email,
    issues,
  };
}
