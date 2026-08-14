import type { AnalysisState } from '../../store'
import type { Subgraph } from '../../types'
import { BubbleLoader } from '../BubbleLoader'

interface GraphStatusBannerProps {
  showLoading: boolean
  error: string | null
  sourceTierNotice: string | null
  analysisState: AnalysisState
  requestDesignMismatch: boolean
  sourceMessage: string | null
  sourceControl: boolean
  selectionTruncated: boolean
  sub: Subgraph | null
  expansionDroppedNodes: number
  expansionDroppedEdges: number
}

export function GraphStatusBanner({
  showLoading,
  error,
  sourceTierNotice,
  analysisState,
  requestDesignMismatch,
  sourceMessage,
  sourceControl,
  selectionTruncated,
  sub,
  expansionDroppedNodes,
  expansionDroppedEdges,
}: GraphStatusBannerProps) {
  return (
    <div className="graph-banner">
      {showLoading && (
        <span className="graph-loading-indicator">
          <BubbleLoader size={32} label="Loading schematic" />
        </span>
      )}
      {error && <span className="msg err">{error}</span>}
      {sourceTierNotice && <span className="msg">{sourceTierNotice}</span>}
      {analysisState === 'stale' && (
        <span className="msg">source changed — synthesize to refresh mapping</span>
      )}
      {requestDesignMismatch && (
        <span className="msg">this cone belongs to the previous synthesis</span>
      )}
      {sourceMessage && <span className="msg">{sourceMessage}</span>}
      {sourceControl && (
        <span className="msg">
          control path selection — reset/clock/enable connectivity is shown
        </span>
      )}
      {selectionTruncated && (
        <span className="msg">selection capped at 200 source lines</span>
      )}
      {sub?.truncated && (
        <span className="msg">
          truncated — {sub.nodes.length} nodes and {sub.edges.length} edges shown;
          analysis limits omitted additional schematic content
        </span>
      )}
      {expansionDroppedNodes > 0 || expansionDroppedEdges > 0 ? (
        <span className="msg">
          expansion reached the render cap — {expansionDroppedNodes}{' '}
          nodes and {expansionDroppedEdges} edges omitted
        </span>
      ) : null}
      {sub && !sub.truncated && (
        <span className="graph-count">
          {sub.nodes.length} nodes · {sub.edges.length} edges
        </span>
      )}
    </div>
  )
}
