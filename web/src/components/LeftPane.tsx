import { lazy, Suspense } from 'react'
import { shallowEqual, useStore } from '../useStore'
import { ErrorStrip } from './ErrorStrip'
import { FileTabs } from './FileTabs'
import { Toolbar } from './Toolbar'

const Editor = lazy(() =>
  import('./Editor').then(({ Editor: EditorComponent }) => ({
    default: EditorComponent,
  })),
)

export function LeftPane() {
  const store = useStore(({ sourceSelection }) => ({ sourceSelection }), shallowEqual)

  return (
    <div className="pane-left">
      <Toolbar />
      <FileTabs />
      <div className="row" style={{ padding: '4px 8px', fontSize: 11 }}>
        <span className="mono faint">
          {store.sourceSelection.file}:{store.sourceSelection.startLine}
          {store.sourceSelection.endLine !== store.sourceSelection.startLine
            ? `–${store.sourceSelection.endLine}`
            : ''}
        </span>
      </div>
      <Suspense
        fallback={
          <div className="editor-loading" role="status">
            Loading editor…
          </div>
        }
      >
        <Editor />
      </Suspense>
      <ErrorStrip />
    </div>
  )
}
