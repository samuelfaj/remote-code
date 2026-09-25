import { defineConfig } from "@playwright/test";

const remoteWeb = process.env.RC003_WEB_URL;
const apiPort = "37117";
const webPort = "37118";
const localApi = `http://127.0.0.1:${apiPort}`;
const localWeb = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: "./apps/web/e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: remoteWeb ?? localWeb,
    browserName: "chromium",
    headless: true,
    viewport: { width: 1280, height: 900 },
  },
  webServer: remoteWeb ? undefined : [
    {
      command: "bun run dev:api",
      url: `${localApi}/api/health/ready`,
      env: { API_PORT: apiPort },
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: "bun run dev:web",
      url: localWeb,
      env: { API_PORT: apiPort, WEB_PORT: webPort },
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
