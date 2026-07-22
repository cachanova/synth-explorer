import { describe, expect, it } from 'vitest'
import { hostPlatform } from './hostPlatform'

describe('host platform detection', () => {
  it('recognizes supported desktop browser families', () => {
    expect(hostPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows')
    expect(hostPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux')
    expect(hostPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7)')).toBe('macos')
    expect(hostPlatform('unknown')).toBe('other')
  })

  it('does not offer desktop Linux or macOS as the detected mobile platform', () => {
    expect(hostPlatform('Mozilla/5.0 (Linux; Android 16; Pixel 10)')).toBe('other')
    expect(hostPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X)')).toBe('other')
    expect(hostPlatform('Mozilla/5.0 (Macintosh; CPU OS 18_6 like Mac OS X) Mobile/15E148')).toBe('other')
  })
})
