import { describe, expect, it } from 'vitest'
import { BUILD_COMMIT, buildCommitUrl, shortBuildCommit } from './buildInfo'

describe('build stamp', () => {
  // Tests always run inside a git checkout, so a missing commit here means the
  // build-time injection broke rather than that the context was unavailable.
  it('carries the commit the bundle was built from', () => {
    expect(BUILD_COMMIT).toMatch(/^[0-9a-f]{40}$/)
  })

  it('abbreviates a commit to twelve characters', () => {
    expect(shortBuildCommit('1a1aea60df89814a07a038a6ebb40dadc76941a6')).toBe('1a1aea60df89')
    expect(shortBuildCommit('abc')).toBe('abc')
  })

  it('links to the full commit so the page resolves', () => {
    expect(buildCommitUrl('1a1aea60df89814a07a038a6ebb40dadc76941a6')).toBe(
      'https://github.com/cachanova/synth-explorer/commit/1a1aea60df89814a07a038a6ebb40dadc76941a6',
    )
  })

  it('has no commit page when the build carries no commit', () => {
    expect(buildCommitUrl('')).toBeNull()
  })
})
