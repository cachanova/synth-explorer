import {
  MAX_GRAPH_RENDER_NODES,
} from '../../lib/graph/graphLimits'
import { isRequestDesignMismatch } from '../../lib/graph/graphOwnership'
import { MIN_GRAPH_MAX_NODES } from '../../lib/graph/graphSettings'
import { shallowEqual, useStore } from '../../useStore'

export function GraphToolbar({ graphInteractive }: { graphInteractive: boolean }) {
  const store = useStore(
    ({ coneReq, design, graphOptions, setGraphOptions, openCone }) => ({
      coneReq,
      design,
      graphOptions,
      setGraphOptions,
      openCone,
    }),
    shallowEqual,
  )
  const { coneReq, design, graphOptions } = store
  const requestDesignMismatch = isRequestDesignMismatch(design?.design_id, coneReq)
  const setOpt = store.setGraphOptions
  const focusAvailable = coneReq?.kind === 'cone' || coneReq?.kind === 'source'

  const reissue = (dir: 'fanin' | 'fanout') => {
    if (coneReq?.kind !== 'cone') return
    store.openCone({
      nodes: coneReq.nodes,
      dir,
      label: coneReq.label,
      highlight: coneReq.highlight,
      rootPort: dir === 'fanin' ? coneReq.rootPort : undefined,
      rootPortBit: dir === 'fanin' ? coneReq.rootPortBit : undefined,
      rootPortBits: dir === 'fanin' ? coneReq.rootPortBits : undefined,
    })
  }

  return (
    <div className="graph-toolbar">
      {coneReq && (
        <>
          <span
            className="mono"
            style={{ color: 'var(--text-dim)', fontSize: 12 }}
          >
            {coneReq.label}
          </span>
          <span className="sep" />
        </>
      )}

      <label className="toggle" title="Max nodes to request">
        max nodes
        <div className="stepper">
          <button
            onClick={() =>
              setOpt({
                maxNodes: Math.max(MIN_GRAPH_MAX_NODES, graphOptions.maxNodes - 100),
              })
            }
          >
            −
          </button>
          <span className="val">{graphOptions.maxNodes}</span>
          <button
            onClick={() =>
              setOpt({
                maxNodes: Math.min(
                  MAX_GRAPH_RENDER_NODES,
                  graphOptions.maxNodes + 100,
                ),
              })
            }
          >
            +
          </button>
        </div>
      </label>
      <label className="toggle">
        <input
          type="checkbox"
          checked={graphOptions.hideControl}
          onChange={(event) => setOpt({ hideControl: event.target.checked })}
        />
        hide control
      </label>
      <label className="toggle">
        <input
          type="checkbox"
          checked={graphOptions.hideConst}
          onChange={(event) => setOpt({ hideConst: event.target.checked })}
        />
        hide const
      </label>

      <label
        className="toggle"
        title="Collapse bit-parallel ports, registers, and combinational logic"
      >
        <input
          type="checkbox"
          checked={graphOptions.groupVectors}
          onChange={(event) => setOpt({ groupVectors: event.target.checked })}
        />
        group vectors
      </label>

      <label
        className="toggle"
        title="Collapse logical memories and parallel mapped memory primitives"
      >
        <input
          type="checkbox"
          checked={graphOptions.groupMemories}
          onChange={(event) => setOpt({ groupMemories: event.target.checked })}
        />
        group memories
      </label>

      <label
        className="toggle"
        title={
          focusAvailable
            ? graphOptions.focus
              ? 'Show only the logic relevant to this selection'
              : 'Show the full schematic and highlight the relevant logic'
            : graphOptions.focus
              ? 'Focus is enabled for the next source selection or cone'
              : 'Focus is disabled for the next source selection or cone'
        }
      >
        <input
          type="checkbox"
          checked={graphOptions.focus}
          onChange={(event) => setOpt({ focus: event.target.checked })}
        />
        Focus
      </label>

      {coneReq?.kind === 'cone' && (
        <>
          <div className="stepper" title="Cone direction">
            <button
              className={coneReq.dir === 'fanin' ? 'primary' : ''}
              disabled={requestDesignMismatch || !graphInteractive}
              onClick={() => reissue('fanin')}
            >
              fanin
            </button>
            <button
              className={coneReq.dir === 'fanout' ? 'primary' : ''}
              disabled={requestDesignMismatch || !graphInteractive}
              onClick={() => reissue('fanout')}
            >
              fanout
            </button>
          </div>

          <label className="toggle">
            depth
            <div className="stepper">
              <button
                onClick={() =>
                  setOpt({ maxDepth: Math.max(1, graphOptions.maxDepth - 1) })
                }
              >
                −
              </button>
              <span className="val">{graphOptions.maxDepth}</span>
              <button onClick={() => setOpt({ maxDepth: graphOptions.maxDepth + 1 })}>
                +
              </button>
            </div>
          </label>
        </>
      )}
    </div>
  )
}
