import { useStore } from '../store'
import { Editor } from './Editor'
import { ErrorStrip } from './ErrorStrip'
import { FileTabs } from './FileTabs'
import { ProbePanel } from './ProbePanel'
import { Toolbar } from './Toolbar'

export function LeftPane() {
  const store = useStore()

  return (
    <div className="pane-left">
      <Toolbar />
      <FileTabs />
      <div className="row" style={{ padding: '4px 8px', gap: 8 }}>
        <button
          disabled={!store.design}
          title="Find synthesized nodes for the current line"
          onClick={() => void store.runProbe()}
        >
          Probe line {store.cursor.line}
        </button>
        <span className="faint" style={{ fontSize: 11 }}>
          {store.activeFileName}
        </span>
      </div>
      <Editor />
      <ProbePanel />
      <ErrorStrip />
    </div>
  )
}
