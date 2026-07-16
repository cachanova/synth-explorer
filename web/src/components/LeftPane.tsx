import { shallowEqual, useStore } from '../useStore'
import { Editor } from './Editor'
import { ErrorStrip } from './ErrorStrip'
import { FileTabs } from './FileTabs'
import { Toolbar } from './Toolbar'

export function LeftPane() {
  const store = useStore(
    ({ sourceSelection, analysisState }) => ({ sourceSelection, analysisState }),
    shallowEqual,
  )

  return (
    <div className="pane-left">
      <Toolbar />
      <FileTabs />
      <div className="row" style={{ padding: '4px 8px', gap: 8, fontSize: 11 }}>
        <span className="mono faint">
          {store.sourceSelection.file}:{store.sourceSelection.startLine}
          {store.sourceSelection.endLine !== store.sourceSelection.startLine
            ? `–${store.sourceSelection.endLine}`
            : ''}
        </span>
        <span className="tag">
          {store.analysisState === 'current'
            ? 'mapping live'
            : store.analysisState === 'refreshing'
              ? 'refreshing'
              : store.analysisState === 'stale'
                ? 'mapping stale'
                : store.analysisState === 'error'
                  ? 'synthesis failed'
                  : 'not synthesized'}
        </span>
      </div>
      <Editor />
      <ErrorStrip />
    </div>
  )
}
