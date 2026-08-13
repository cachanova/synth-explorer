import type { HostPlatform } from './hostPlatform'

const RELEASE_DOWNLOAD_BASE = 'https://github.com/cachanova/synth-explorer/releases/latest/download'

export interface LocalDownload {
  asset: string
  label: string
  platform: Exclude<HostPlatform, 'other'>
}

export const LOCAL_DOWNLOADS: readonly LocalDownload[] = [
  {
    platform: 'windows',
    asset: 'synth-explorer-local-windows-x86_64.zip',
    label: 'Windows x64',
  },
  {
    platform: 'linux',
    asset: 'synth-explorer-local-linux-x86_64.tar.gz',
    label: 'Linux x86-64',
  },
  {
    platform: 'macos',
    asset: 'synth-explorer-local-macos-arm64.tar.gz',
    label: 'macOS Apple Silicon',
  },
  {
    platform: 'macos',
    asset: 'synth-explorer-local-macos-x86_64.tar.gz',
    label: 'macOS Intel',
  },
]

export function localDownloadsFor(platform: HostPlatform): readonly LocalDownload[] {
  if (platform === 'other') return LOCAL_DOWNLOADS
  return LOCAL_DOWNLOADS.filter((download) => download.platform === platform)
}

export function localDownloadUrl(asset: string): string {
  return `${RELEASE_DOWNLOAD_BASE}/${asset}`
}

export function localChecksumUrl(asset: string): string {
  return localDownloadUrl(`${asset}.sha256`)
}
