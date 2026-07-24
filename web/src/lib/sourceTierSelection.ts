import {
  fetchSourceTiers,
  fetchSourceTiersForNets,
  type SourceTiersResponse,
} from './sourceTiers'

export type SourceTierSelectionTarget =
  | { kind: 'nodes'; nodeIds: number[] }
  | { kind: 'nets'; names: string[] }

export interface SourceTierSelection {
  target: SourceTierSelectionTarget
  response: SourceTiersResponse
}

type FetchSourceTiers = (
  target: SourceTierSelectionTarget,
) => Promise<SourceTiersResponse>

function fetchSelectionSourceTiers(
  target: SourceTierSelectionTarget,
): Promise<SourceTiersResponse> {
  return target.kind === 'nodes'
    ? fetchSourceTiers(target.nodeIds)
    : fetchSourceTiersForNets(target.names)
}

/**
 * Latest-only schematic source lookup. Calling with a new selection clears
 * the current result before starting its replacement.
 */
export function createSourceTierSelectionController(
  commit: (selection: SourceTierSelection | null) => void,
  fetch: FetchSourceTiers = fetchSelectionSourceTiers,
): (target: SourceTierSelectionTarget) => void {
  let sequence = 0

  return (target) => {
    const requestSequence = ++sequence
    commit(null)
    const values = target.kind === 'nodes' ? target.nodeIds : target.names
    if (values.length === 0) return

    const requestedTarget = target.kind === 'nodes'
      ? { kind: 'nodes' as const, nodeIds: [...target.nodeIds] }
      : { kind: 'nets' as const, names: [...target.names] }
    void fetch(requestedTarget)
      .then((response) => {
        if (requestSequence !== sequence) return
        commit({ target: requestedTarget, response })
      })
      .catch(() => {
        if (requestSequence !== sequence) return
        commit(null)
      })
  }
}
