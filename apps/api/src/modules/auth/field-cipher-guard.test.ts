import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalKeyFieldCipher } from "./adapters/field-cipher";

const KEY = new Uint8Array(32).fill(7);

describe("LocalKeyFieldCipher production guard", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuses to run in production without the synthetic-data acknowledgement", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_SYNTHETIC_DATA_KEYS", "");
    expect(() => new LocalKeyFieldCipher(KEY)).toThrow(/synthetic data only/);
  });

  it("runs in production only with the explicit acknowledgement", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_SYNTHETIC_DATA_KEYS", "true");
    expect(() => new LocalKeyFieldCipher(KEY)).not.toThrow();
  });

  it("runs in test and development", () => {
    vi.stubEnv("NODE_ENV", "test");
    expect(() => new LocalKeyFieldCipher(KEY)).not.toThrow();
  });
});
