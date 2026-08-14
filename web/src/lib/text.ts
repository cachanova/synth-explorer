export function truncate(value: string, maxLength: number): string {
  if (maxLength < 3 || value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 1)}…`
}

export function truncateMid(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const half = Math.floor((maxLength - 1) / 2)
  return `${value.slice(0, half)}…${value.slice(value.length - half)}`
}
