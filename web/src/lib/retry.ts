export const DEFAULT_RETRY_DELAY_MS = 5_000
export const MIN_RETRY_DELAY_MS = 1_000
export const MAX_RETRY_DELAY_MS = 60_000

export function boundedRetryDelayMs(delayMs: number | undefined): number {
  if (delayMs == null || !Number.isFinite(delayMs)) return DEFAULT_RETRY_DELAY_MS
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(MIN_RETRY_DELAY_MS, delayMs))
}

/** Parse the integer-seconds Retry-After form emitted by the synthesis API. */
export function parseRetryAfterMs(value: string | null): number | undefined {
  const trimmed = value?.trim()
  if (!trimmed || !/^\d+$/.test(trimmed)) return undefined
  const seconds = Number(trimmed)
  if (!Number.isSafeInteger(seconds)) return undefined
  if (seconds >= MAX_RETRY_DELAY_MS / 1_000) return MAX_RETRY_DELAY_MS
  return boundedRetryDelayMs(seconds * 1_000)
}
