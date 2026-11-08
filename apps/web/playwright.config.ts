import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // The shopper mock API is one in-memory state shared by shop.spec and orders.spec, so spec files must not run in parallel.
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://localhost:3100" },
  webServer: [
    { command: "node e2e/mock-api.mjs", url: "http://localhost:3101/health", reuseExistingServer: false, timeout: 20_000 },
    {
      command: "pnpm exec next start --port 3100",
      url: "http://localhost:3100/robots.txt",
      reuseExistingServer: false,
      timeout: 60_000,
      env: { API_URL: "http://localhost:3101", UPLOAD_ORIGIN: "https://uploads.example.test" },
    },
  ],
});
