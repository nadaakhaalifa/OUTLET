import type { ChannelType } from "../api/schemas-phase2";
import { err, ok, type Result } from "../lib/result";

/**
 * Port for the marketplace OAuth hand-off. The API returns a `connect_url` for a pending connection; the browser must
 * follow it. The real adapter is a redirect; tests and previews use the fake. Nothing here ever sees a token.
 */
export interface BeginInput { readonly type: ChannelType; readonly shopDomain: string; readonly connectUrl: string }
export interface ChannelOAuthPort {
  begin(input: BeginInput): Promise<Result<{ readonly redirectTo: string }, "untrusted_url">>;
}

/** Only https URLs on the shop's own domain (or *.myshopify.com for Shopify) may be redirected to: no open redirect. */
export function isTrustedConnectUrl(type: ChannelType, shopDomain: string, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "") return false;
  const host = u.hostname.toLowerCase();
  const shop = shopDomain.toLowerCase();
  return host === shop || host.endsWith(`.${shop}`) || (type === "shopify" && host.endsWith(".myshopify.com"));
}

export class RedirectOAuth implements ChannelOAuthPort {
  async begin(i: BeginInput): Promise<Result<{ readonly redirectTo: string }, "untrusted_url">> {
    return isTrustedConnectUrl(i.type, i.shopDomain, i.connectUrl) ? ok({ redirectTo: i.connectUrl }) : err("untrusted_url");
  }
}

export class FakeChannelOAuth implements ChannelOAuthPort {
  readonly begun: BeginInput[] = [];
  async begin(i: BeginInput): Promise<Result<{ readonly redirectTo: string }, "untrusted_url">> {
    this.begun.push(i);
    return isTrustedConnectUrl(i.type, i.shopDomain, i.connectUrl) ? ok({ redirectTo: i.connectUrl }) : err("untrusted_url");
  }
}
