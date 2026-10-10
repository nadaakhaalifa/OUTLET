// The authorization matrix lives in apps/api/test/. This entry makes the package's default
// vitest include (src/**/*.test.ts) run it and puts it under `tsc --noEmit`.
import "../test/authz-matrix.test";
