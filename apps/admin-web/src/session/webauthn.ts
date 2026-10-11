/** Browser-side helpers (no network). Kept free of DOM globals so the encoding is unit-testable. */
export function toBase64Url(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes);
  let bin = "";
  for (const b of u8) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): ArrayBuffer {
  const pad = "=".repeat((4 - (value.length % 4)) % 4);
  const bin = atob(value.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export interface AssertionLike {
  readonly id: string;
  readonly rawId: ArrayBuffer;
  readonly type: string;
  readonly response: {
    readonly clientDataJSON: ArrayBuffer;
    readonly authenticatorData: ArrayBuffer;
    readonly signature: ArrayBuffer;
    readonly userHandle: ArrayBuffer | null;
  };
}

export function serializeAssertion(a: AssertionLike): Record<string, unknown> {
  return {
    id: a.id,
    raw_id: toBase64Url(a.rawId),
    type: a.type,
    response: {
      client_data_json: toBase64Url(a.response.clientDataJSON),
      authenticator_data: toBase64Url(a.response.authenticatorData),
      signature: toBase64Url(a.response.signature),
      user_handle: a.response.userHandle === null ? null : toBase64Url(a.response.userHandle),
    },
  };
}
