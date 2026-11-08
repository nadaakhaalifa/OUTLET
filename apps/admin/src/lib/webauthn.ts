/** WebAuthn JSON <-> ArrayBuffer helpers (base64url, no padding). */
export const toB64u = (buf: ArrayBuffer): string => {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const fromB64u = (v: string): ArrayBuffer => {
  const b = atob(v.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(v.length / 4) * 4, "="));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out.buffer;
};

interface RequestOptionsJson {
  readonly challenge: string;
  readonly rpId?: string;
  readonly timeout?: number;
  readonly userVerification?: UserVerificationRequirement;
  readonly allowCredentials?: readonly { readonly id: string; readonly type: "public-key" }[];
}

export function requestOptionsFromJson(json: unknown): PublicKeyCredentialRequestOptions | null {
  if (typeof json !== "object" || json === null) return null;
  const o = json as Partial<RequestOptionsJson>;
  if (typeof o.challenge !== "string") return null;
  return {
    challenge: fromB64u(o.challenge),
    ...(o.rpId !== undefined ? { rpId: o.rpId } : {}),
    ...(o.timeout !== undefined ? { timeout: o.timeout } : {}),
    userVerification: o.userVerification ?? "required",
    ...(o.allowCredentials !== undefined ? { allowCredentials: o.allowCredentials.map((c) => ({ type: c.type, id: fromB64u(c.id) })) } : {}),
  };
}

/** AuthenticatorAssertionResponse -> JSON the API verifies. */
export function assertionToJson(cred: PublicKeyCredential): Record<string, unknown> {
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: toB64u(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: toB64u(r.clientDataJSON),
      authenticatorData: toB64u(r.authenticatorData),
      signature: toB64u(r.signature),
      ...(r.userHandle !== null ? { userHandle: toB64u(r.userHandle) } : {}),
    },
  };
}
