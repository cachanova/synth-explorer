import { describe, expect, it } from 'vitest'
import {
  LOCAL_DOWNLOADS,
  localChecksumUrl,
  localDownloadsFor,
  localDownloadUrl,
} from './localDownload'

describe('local application downloads', () => {
  it('publishes one Windows and Linux artifact plus both macOS architectures', () => {
    expect(localDownloadsFor('windows').map((entry) => entry.asset)).toEqual([
      'synth-explorer-local-windows-x86_64.zip',
    ])
    expect(localDownloadsFor('linux').map((entry) => entry.asset)).toEqual([
      'synth-explorer-local-linux-x86_64.tar.gz',
    ])
    expect(localDownloadsFor('macos').map((entry) => entry.asset)).toEqual([
      'synth-explorer-local-macos-arm64.tar.gz',
      'synth-explorer-local-macos-x86_64.tar.gz',
    ])
    expect(localDownloadsFor('other')).toEqual(LOCAL_DOWNLOADS)
  })

  it('uses immutable release asset names under the latest release', () => {
    const asset = 'synth-explorer-local-macos-arm64.tar.gz'
    expect(localDownloadUrl(asset)).toBe(
      `https://github.com/cachanova/synth-explorer/releases/latest/download/${asset}`,
    )
    expect(localChecksumUrl(asset)).toBe(`${localDownloadUrl(asset)}.sha256`)
  })
})
