/**
 * "Track your order" prompt (spec F4). The notification permission is asked once, and only on the order-success screen
 * after a completed purchase: never at launch, never to a guest browsing. The OS permission call sits behind a port;
 * until a push adapter is configured the port is Unconfigured and the prompt does not appear (fail closed).
 */
export const NOTIF_PROMPT_KEY = "outlet.pref.notifprompt";

export type PermissionOutcome = "granted" | "denied" | "unavailable";
export interface NotificationPermissionPort { request(): Promise<PermissionOutcome> }

/** Default until a push adapter exists: nothing is requested. */
export const unconfiguredNotificationPermission: NotificationPermissionPort = { request: () => Promise.resolve("unavailable") };

export function shouldAskNotificationPermission(input: { readonly purchaseCompleted: boolean; readonly alreadyAsked: boolean; readonly adapterConfigured: boolean }): boolean {
  return input.purchaseCompleted && !input.alreadyAsked && input.adapterConfigured;
}

export interface AskDeps {
  readonly port: NotificationPermissionPort;
  readonly read: () => Promise<string | null>;
  readonly write: (v: string) => Promise<void>;
}

/** Records that we asked (even when denied) so the person is never asked twice. */
export async function askOnce(deps: AskDeps, purchaseCompleted: boolean): Promise<PermissionOutcome | "skipped"> {
  const asked = (await deps.read()) !== null;
  if (!shouldAskNotificationPermission({ purchaseCompleted, alreadyAsked: asked, adapterConfigured: deps.port !== unconfiguredNotificationPermission })) return "skipped";
  await deps.write("1");
  return deps.port.request();
}
