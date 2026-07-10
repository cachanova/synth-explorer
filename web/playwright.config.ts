import { defineConfig } from '@playwright/test'

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: 'line',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:8787',
    browserName: 'chromium',
    headless: true,
    trace: 'retain-on-failure',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
})
