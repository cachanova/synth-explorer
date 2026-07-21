import { defineConfig } from '@playwright/test'
import {
  CAPABILITIES_SEEN_KEY,
  CAPABILITIES_VERSION,
} from './src/lib/capabilities'

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4173'
const startsLocalPreview = baseURL === 'http://127.0.0.1:4173'
const baseOrigin = new URL(baseURL).origin

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: 'line',
  webServer: startsLocalPreview
    ? {
        command: 'npm run preview -- --host 127.0.0.1 --port 4173',
        url: baseURL,
        reuseExistingServer: true,
        timeout: 30_000,
      }
    : undefined,
  use: {
    baseURL,
    browserName: 'chromium',
    headless: true,
    trace: 'retain-on-failure',
    storageState: {
      cookies: [],
      origins: [
        {
          origin: baseOrigin,
          localStorage: [
            {
              name: CAPABILITIES_SEEN_KEY,
              value: String(CAPABILITIES_VERSION),
            },
          ],
        },
      ],
    },
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
})
