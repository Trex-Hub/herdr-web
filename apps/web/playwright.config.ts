import { defineConfig } from "@playwright/test"

/** Ports the browser test uses, so it can run beside `pnpm backend dev` and `pnpm web dev`. */
export const WEB_PORT = 13000
export const BACKEND_PORT = 17420

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  workers: 1,
  reporter: "list",
  globalSetup: "./e2e/global-setup.ts",
  use: { baseURL: `http://localhost:${WEB_PORT}`, trace: "retain-on-failure" },
  webServer: {
    command: `next dev --port ${WEB_PORT}`,
    url: `http://localhost:${WEB_PORT}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { NEXT_PUBLIC_BACKEND_URL: `http://localhost:${BACKEND_PORT}`, NEXT_DIST_DIR: ".next-e2e" },
  },
})
