import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// The checkout redirect allow-list fails closed when unset; the web tests redirect to the fake PSP host `pay.example`.
process.env.NEXT_PUBLIC_PSP_REDIRECT_HOSTS ??= "pay.example";

afterEach(() => {
  cleanup();
});
