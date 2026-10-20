import type { OtpSender } from "@outlet/auth-core";
import { UnconfiguredOtpSender } from "../../../modules/auth";
import { UnconfiguredChannelProvider, type ChannelProvider, type ProviderRegistry } from "../../../modules/notifications";
import { EXTERNAL_CHANNELS, type ExternalChannel } from "../../../modules/notifications/domain/types";
import { markConfigured, ProviderNotConfiguredError, type ProviderName } from "../../unconfigured";
import type { CommsConfig } from "./config";
import type { HttpDeps } from "./core";
import { PostmarkEmailProvider, type EmailSuppressionSink } from "./email";
import { ExpoPushProvider, type PushTicketStore, type PushTokenDeactivator } from "./expo-push";
import { FailoverOtpSender } from "./failover";
import { SmsOtpSender, TwilioStyleSmsProvider, type PrefixBudget } from "./sms";
import { WhatsAppCloudProvider, WhatsAppOtpSender } from "./whatsapp";

/** Which provider name and vendor families back each notification channel (ADR-0034). Every channel must appear. */
export const COMMS_BINDINGS: Readonly<Record<ExternalChannel, { readonly provider: ProviderName; readonly vendors: readonly string[] }>> = {
  push: { provider: "push.apns-fcm", vendors: ["expo_push"] },
  sms: { provider: "messaging.sms-whatsapp", vendors: ["sms_a", "sms_b"] },
  whatsapp: { provider: "messaging.sms-whatsapp", vendors: ["wa_cloud"] },
  email: { provider: "messaging.email", vendors: ["email_postmark"] },
};

export interface CommsDeps {
  readonly http: HttpDeps;
  readonly nowMs: () => number;
  readonly deactivator: PushTokenDeactivator;
  readonly tickets: PushTicketStore;
  readonly suppression: EmailSuppressionSink;
  readonly prefixBudget: PrefixBudget | null;
}

export interface CommsWiring {
  readonly registry: ProviderRegistry;
  readonly otpSender: OtpSender;
  readonly configured: readonly ExternalChannel[];
  readonly push: ExpoPushProvider | null;
  readonly smsProviders: readonly TwilioStyleSmsProvider[];
  readonly whatsapp: WhatsAppCloudProvider | null;
  readonly email: PostmarkEmailProvider | null;
}

/** Real adapters only for complete env groups; every other channel keeps its Unconfigured provider. */
export function buildCommsWiring(config: CommsConfig, deps: CommsDeps): CommsWiring {
  const push = config.push === null ? null : new ExpoPushProvider({ http: deps.http, accessToken: config.push.accessToken, deactivator: deps.deactivator, tickets: deps.tickets, nowMs: deps.nowMs });
  const smsProviders = config.sms.map(
    (c) => new TwilioStyleSmsProvider(c, { http: deps.http, policy: { allowedPrefixes: config.allowedPrefixes }, budget: deps.prefixBudget, nowMs: deps.nowMs }),
  );
  const whatsapp = config.whatsapp === null ? null : new WhatsAppCloudProvider(config.whatsapp, deps.http);
  const email = config.email === null ? null : new PostmarkEmailProvider(config.email, deps.http);

  const real: Record<ExternalChannel, readonly ChannelProvider[]> = {
    push: push === null ? [] : [push],
    sms: smsProviders,
    whatsapp: whatsapp === null ? [] : [whatsapp],
    email: email === null ? [] : [email],
  };
  const byChannel = {} as Record<ExternalChannel, readonly ChannelProvider[]>;
  const configured: ExternalChannel[] = [];
  for (const ch of EXTERNAL_CHANNELS) {
    const binding = COMMS_BINDINGS[ch];
    if (real[ch].length > 0) {
      byChannel[ch] = real[ch];
      configured.push(ch);
      markConfigured(binding.provider);
    } else {
      byChannel[ch] = [new UnconfiguredChannelProvider(`unconfigured_${ch}`, ch, (op) => new ProviderNotConfiguredError(binding.provider, op))];
    }
  }

  const chain: OtpSender[] = smsProviders.map((p) => new SmsOtpSender(p));
  if (whatsapp !== null && config.whatsapp?.otpTemplate !== undefined) chain.push(new WhatsAppOtpSender(whatsapp, config.whatsapp.otpTemplate));
  const [first, ...rest] = chain;
  const otpSender = first === undefined ? new UnconfiguredOtpSender("sms") : rest.length === 0 ? first : new FailoverOtpSender([first, ...rest]);

  return { registry: { providersFor: (c) => byChannel[c] }, otpSender, configured, push, smsProviders, whatsapp, email };
}
