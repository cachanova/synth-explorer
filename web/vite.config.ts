/// <reference types="vitest/config" />
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The build stamp lets a visitor or a local-app user tell which commit their
// bundle came from. Vercel and GitHub Actions each supply the commit; a local
// build reads it from git. Only the commit is baked in, never a timestamp, so
// one commit always produces the same asset hashes and a website build stays
// comparable to a packaged download.
function resolveBuildCommit(): string {
  const fromCi = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA
  if (fromCi) return fromCi
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_COMMIT__: JSON.stringify(resolveBuildCommit()),
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'editor',
              test: /node_modules[\\/](?:@codemirror[\\/](?!lint[\\/])|@lezer[\\/]|@marijn[\\/]|style-mod[\\/]|w3c-keyname[\\/])/,
            },
          ],
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
