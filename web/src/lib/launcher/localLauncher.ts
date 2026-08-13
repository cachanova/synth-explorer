export function isLocalLauncher(
  search = typeof window === 'undefined' ? '' : window.location.search,
): boolean {
  return new URLSearchParams(search).get('launcher') === '1'
}
