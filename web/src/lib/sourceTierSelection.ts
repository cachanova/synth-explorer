import {
  fetchSourceTiers,
  type SourceTiersResponse,
} from './sourceTiers'

export interface SourceTierSelection {
  nodeIds: number[]
  response: SourceTiersResponse
}

type FetchSourceTiers = (nodeIds: number[]) => Promise<SourceTiersResponse>

/**
 * Latest-only selected-node source lookup. Calling with a new selection clears
 * the current result before starting its replacement.
 */
export function createSourceTierSelectionController(
  commit: (selection: SourceTierSelection | null) => void,
  fetch: FetchSourceTiers = fetchSourceTiers,
): (nodeIds: number[]) => void {
  let sequence = 0

  return (nodeIds) => {
    const requestSequence = ++sequence
    commit(null)
    if (nodeIds.length === 0) return

    const requestedIds = [...nodeIds]
    void fetch(requestedIds)
      .then((response) => {
        if (requestSequence !== sequence) return
        commit({ nodeIds: requestedIds, response })
      })
      .catch(() => {
        if (requestSequence !== sequence) return
        commit(null)
      })
  }
}
