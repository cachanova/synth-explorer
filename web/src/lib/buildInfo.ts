// Identifies the commit this bundle was built from. `vite.config.ts` injects
// the value; it is empty only when the build ran with no git or CI context.
declare const __BUILD_COMMIT__: string

const COMMIT_BASE = 'https://github.com/cachanova/synth-explorer/commit'
const SHORT_LENGTH = 12

export const BUILD_COMMIT: string = __BUILD_COMMIT__

/** Abbreviation shown in the UI. */
export function shortBuildCommit(commit: string): string {
  return commit.slice(0, SHORT_LENGTH)
}

/** Commit page for `commit`, or null when the build carries no commit. */
export function buildCommitUrl(commit: string): string | null {
  if (!commit) return null
  return `${COMMIT_BASE}/${commit}`
}
