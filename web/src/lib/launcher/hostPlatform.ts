export type HostPlatform = 'linux' | 'windows' | 'macos' | 'other'

export function hostPlatform(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): HostPlatform {
  const agent = userAgent.toLowerCase()
  if (/(android|iphone|ipad|ipod|mobile)/.test(agent)) return 'other'
  if (agent.includes('windows')) return 'windows'
  if (agent.includes('macintosh') || agent.includes('mac os')) return 'macos'
  if (agent.includes('linux')) return 'linux'
  return 'other'
}
