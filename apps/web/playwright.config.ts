import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: "list",
  use: { baseURL: "http://localhost:3100" },
  webServer: {
    command: "pnpm exec next start --port 3100",
    url: "http://localhost:3100/robots.txt",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
