"use client";
import { useState, useTransition } from "react";
import { beginPasskeyAction, finishPasskeyAction } from "../server/actions";
import { fromBase64Url, serializeAssertion, type AssertionLike } from "../session/webauthn";

export interface PasskeyLoginProps {
  readonly labels: { readonly signIn: string; readonly working: string; readonly unsupported: string; readonly failed: string; readonly cancelled: string };
}

export function PasskeyLogin({ labels }: PasskeyLoginProps) {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const go = (): void => {
    setMessage(null);
    start(async () => {
      if (typeof navigator === "undefined" || navigator.credentials === undefined || typeof PublicKeyCredential === "undefined") {
        setMessage(labels.unsupported);
        return;
      }
      const opts = await beginPasskeyAction();
      if (!opts.ok) {
        setMessage(labels.failed);
        return;
      }
      let cred: Credential | null;
      try {
        cred = await navigator.credentials.get({
          publicKey: { challenge: fromBase64Url(opts.challenge), rpId: opts.rpId, userVerification: "required", timeout: 60_000 },
        });
      } catch {
        setMessage(labels.cancelled);
        return;
      }
      if (cred === null || !(cred instanceof PublicKeyCredential) || !(cred.response instanceof AuthenticatorAssertionResponse)) {
        setMessage(labels.failed);
        return;
      }
      const like: AssertionLike = {
        id: cred.id,
        rawId: cred.rawId,
        type: cred.type,
        response: {
          clientDataJSON: cred.response.clientDataJSON,
          authenticatorData: cred.response.authenticatorData,
          signature: cred.response.signature,
          userHandle: cred.response.userHandle,
        },
      };
      const res = await finishPasskeyAction(opts.challengeId, JSON.stringify(serializeAssertion(like)));
      if (res.ok) window.location.assign("/");
      else setMessage(labels.failed);
    });
  };

  return (
    <div>
      <button type="button" className="btn primary brand" onClick={go} disabled={pending}>
        {pending ? labels.working : labels.signIn}
      </button>
      {message === null ? null : <p role="alert" className="notice error">{message}</p>}
    </div>
  );
}
