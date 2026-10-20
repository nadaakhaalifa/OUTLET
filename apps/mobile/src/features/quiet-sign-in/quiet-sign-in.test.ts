import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ApiErrorCode, ApiResult, VerifiedLogin } from "../../api/port";
import { noteText } from "../guest";
import { runQuietVerify, type QuietVerifyDeps } from "./model";

const TOKENS = { accessToken: "a", refreshToken: "r", accessExpiresAtMs: 1 };

function deps(result: ApiResult<VerifiedLogin>) {
  const calls: string[] = [];
  const modes: (string | undefined)[] = [];
  const d: QuietVerifyDeps = {
    verifyOtp: async (i) => { modes.push(i.mode); return result; },
    save: async () => { calls.push("save"); },
    markOnboardingDone: async () => { calls.push("done"); },
  };
  return { d, calls, modes };
}
const fail = (code: ApiErrorCode): ApiResult<VerifiedLogin> => ({ ok: false, error: { code } });

describe("quiet sign-in verify (G-9 existing_only)", () => {
  it("always sends mode existing_only, and a real account is stored", async () => {
    const { d, calls, modes } = deps({ ok: true, value: { tokens: TOKENS, isNewAccount: false } });
    expect(await runQuietVerify(d, "+201000000000", "123456")).toEqual({ kind: "signed_in" });
    expect(modes).toEqual(["existing_only"]);
    expect(calls).toEqual(["save", "done"]);
  });
  it("404 no_account: honest outcome, nothing stored", async () => {
    const { d, calls } = deps(fail("no_account"));
    expect(await runQuietVerify(d, "+201000000000", "123456")).toEqual({ kind: "no_account" });
    expect(calls).toEqual([]);
  });
  it("flag-blocked 404 is 'not available', never create mode, nothing stored", async () => {
    const { d, calls, modes } = deps(fail("sign_in_unavailable"));
    expect(await runQuietVerify(d, "+201000000000", "123456")).toEqual({ kind: "unavailable" });
    expect(calls).toEqual([]);
    expect(modes).toEqual(["existing_only"]);
  });
  it("replayed or wrong code (422 otp_invalid) is an error and stores nothing", async () => {
    const { d, calls } = deps(fail("invalid_code"));
    expect(await runQuietVerify(d, "+201000000000", "000000")).toEqual({ kind: "error", errorKey: "onboarding.otp.errorInvalid" });
    expect(calls).toEqual([]);
  });
});

describe("merge summary notes", () => {
  it("keeps the larger-quantity sentence", () => {
    expect(noteText({ kind: "kept_larger", title: "Shirt", localQty: 2, accountQty: 3, qty: 3, reason: null })).toEqual({
      key: "guestMerge.keptLarger", params: { title: "Shirt", local: 2, account: 3, qty: 3 },
    });
  });
});

describe("R0: no sign-up reference in this feature", () => {
  it("none of the files names the sign-up routes or account-creation", () => {
    const dirs = [__dirname, `${__dirname}/../../app`];
    const files = [
      ...readdirSync(__dirname).filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts")).map((f) => `${__dirname}/${f}`),
      `${dirs[1]}/sign-in.tsx`,
    ];
    for (const f of files) expect(readFileSync(f, "utf8")).not.toMatch(/\/sign-up\b|\/onboarding\/(?:account|consents|otp)\b|AccountCreate|\bsignUp\.|onboarding\.account\./);
  });
});
