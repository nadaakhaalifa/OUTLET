import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://localhost:3300" },
  webServer: [
    { command: "node e2e/mock-api.mjs", url: "http://localhost:3301/health", reuseExistingServer: false, timeout: 20_000 },
    {
      command: "pnpm exec next start --port 3300",
      url: "http://localhost:3300/eg-ar/login",
      reuseExistingServer: false,
      timeout: 60_000,
      env: { API_URL: "http://localhost:3301" },
    },
  ],
});
