export const CAPABILITIES_VERSION = 1
export const CAPABILITIES_SEEN_KEY = 'synthexplorer.capabilitiesSeenVersion.v1'

export type CapabilitiesDialogMode = 'full' | 'updates'

export interface Capability {
  title: string
  description: string
  version: number
}

export interface CapabilitySection {
  id: string
  title: string
  capabilities: Capability[]
}

export const CAPABILITY_SECTIONS: CapabilitySection[] = [
  {
    id: 'synthesis',
    title: 'Synthesis',
    capabilities: [
      {
        title: 'Verilog, SystemVerilog, and VHDL',
        description: 'Synthesize common HDL formats directly in the browser.',
        version: 1,
      },
      {
        title: 'Browser Yosys and local Vivado',
        description: 'Use WebAssembly synthesis or connect to an installed Xilinx flow.',
        version: 1,
      },
      {
        title: 'Target modes',
        description: 'Compare RTL structure, generic gates, LUT4/LUT6, iCE40, ECP5, and Xilinx mappings.',
        version: 1,
      },
      {
        title: 'Curated flags',
        description: 'Tune synthesis with searchable, per-mode flag controls.',
        version: 1,
      },
      {
        title: 'Auto or manual compile',
        description: 'Refresh after edits or run synthesis on demand.',
        version: 1,
      },
    ],
  },
  {
    id: 'analysis',
    title: 'Analysis',
    capabilities: [
      {
        title: 'Overview metrics',
        description: 'Inspect cell counts, register groups, IO, warnings, and structural depth.',
        version: 1,
      },
      {
        title: 'Logical endpoints',
        description: 'Browse registers, outputs, boundary inputs, bit cohorts, and source links.',
        version: 1,
      },
      {
        title: 'Longest paths',
        description: 'Rank structural path variants by depth and estimated delay where available.',
        version: 1,
      },
      {
        title: 'High fanout',
        description: 'Find control nets and drivers with broad endpoint reach.',
        version: 1,
      },
      {
        title: 'Timing estimates',
        description: 'Compare notional profiles, speed grades, and custom delay models. Not a timing-closure report.',
        version: 1,
      },
    ],
  },
  {
    id: 'schematic',
    title: 'Schematic',
    capabilities: [
      {
        title: 'Full or focused graphs',
        description: 'View the larger schematic or isolate the current cone, path, or source selection.',
        version: 1,
      },
      {
        title: 'Fanin and fanout cones',
        description: 'Open cones from endpoints, paths, fanout rows, or graph nodes.',
        version: 1,
      },
      {
        title: 'Source cross-probing',
        description: 'Select HDL lines and see the related synthesized region.',
        version: 1,
      },
      {
        title: 'Path highlighting',
        description: 'Project a reported path directly onto the schematic.',
        version: 1,
      },
    ],
  },
]

export function parseCapabilitiesSeenVersion(value: string | null): number {
  if (value == null) return 0
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) return 0
  return parsed
}

export function loadCapabilitiesSeenVersion(): number {
  try {
    return parseCapabilitiesSeenVersion(localStorage.getItem(CAPABILITIES_SEEN_KEY))
  } catch {
    return 0
  }
}

export function saveCapabilitiesSeenVersion(
  version = CAPABILITIES_VERSION,
): void {
  try {
    localStorage.setItem(CAPABILITIES_SEEN_KEY, String(version))
  } catch {
    // Treat storage failures as session-local. The modal remains dismissible.
  }
}

export function capabilitySectionsFor(
  mode: CapabilitiesDialogMode,
  seenVersion: number,
  sections: CapabilitySection[] = CAPABILITY_SECTIONS,
): CapabilitySection[] {
  if (mode === 'full') return sections
  return sections
    .map((section) => ({
      ...section,
      capabilities: section.capabilities.filter(
        (capability) => capability.version > seenVersion,
      ),
    }))
    .filter((section) => section.capabilities.length > 0)
}

export function initialCapabilitiesDialogMode(
  seenVersion: number,
  currentVersion = CAPABILITIES_VERSION,
  sections: CapabilitySection[] = CAPABILITY_SECTIONS,
): CapabilitiesDialogMode | null {
  if (seenVersion >= currentVersion) return null
  if (seenVersion === 0) return 'full'
  return capabilitySectionsFor('updates', seenVersion, sections).length > 0
    ? 'updates'
    : null
}
