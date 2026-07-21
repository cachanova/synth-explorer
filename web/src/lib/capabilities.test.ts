import { describe, expect, it } from 'vitest'
import {
  capabilitySectionsFor,
  initialCapabilitiesDialogMode,
  parseCapabilitiesSeenVersion,
  type CapabilitySection,
} from './capabilities'

const TEST_SECTIONS: CapabilitySection[] = [
  {
    id: 'one',
    title: 'One',
    capabilities: [
      { title: 'Existing', description: 'Already seen.', version: 1 },
      { title: 'Added', description: 'New in this version.', version: 2 },
    ],
  },
  {
    id: 'two',
    title: 'Two',
    capabilities: [
      { title: 'Later', description: 'Newer still.', version: 3 },
    ],
  },
]

describe('capabilities versioning', () => {
  it('parses missing or invalid seen versions as unseen', () => {
    expect(parseCapabilitiesSeenVersion(null)).toBe(0)
    expect(parseCapabilitiesSeenVersion('')).toBe(0)
    expect(parseCapabilitiesSeenVersion('-1')).toBe(0)
    expect(parseCapabilitiesSeenVersion('1.5')).toBe(0)
    expect(parseCapabilitiesSeenVersion('abc')).toBe(0)
    expect(parseCapabilitiesSeenVersion('2')).toBe(2)
  })

  it('shows the full catalog for a first-time user', () => {
    expect(initialCapabilitiesDialogMode(0, 2, TEST_SECTIONS)).toBe('full')
  })

  it('shows only capabilities added after the seen version', () => {
    expect(capabilitySectionsFor('updates', 1, TEST_SECTIONS)).toEqual([
      {
        id: 'one',
        title: 'One',
        capabilities: [
          { title: 'Added', description: 'New in this version.', version: 2 },
        ],
      },
      {
        id: 'two',
        title: 'Two',
        capabilities: [
          { title: 'Later', description: 'Newer still.', version: 3 },
        ],
      },
    ])
  })

  it('uses update mode for returning users with unseen capability entries', () => {
    expect(initialCapabilitiesDialogMode(1, 3, TEST_SECTIONS)).toBe('updates')
  })

  it('does not open an empty update dialog', () => {
    expect(initialCapabilitiesDialogMode(2, 3, TEST_SECTIONS.slice(0, 1))).toBeNull()
    expect(initialCapabilitiesDialogMode(3, 3, TEST_SECTIONS)).toBeNull()
  })
})
