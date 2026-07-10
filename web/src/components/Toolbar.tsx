import { MODE_LABELS } from '../api'
import { useStore } from '../store'
import type { Mode } from '../types'

export function Toolbar() {
  const store = useStore()

  return (
    <div className="toolbar">
      <label className="field">
        <span>Example</span>
        <select
          value=""
          onChange={(e) => {
            const ex = store.examples.find((x) => x.name === e.target.value)
            if (ex) store.loadExample(ex)
          }}
        >
          <option value="">
            {store.examples.length ? 'Load example…' : '(no examples)'}
          </option>
          {store.examples.map((ex) => (
            <option key={ex.name} value={ex.name}>
              {ex.title || ex.name}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Top module</span>
        <input
          style={{ width: 110 }}
          placeholder="auto"
          value={store.top}
          onChange={(e) => store.setTop(e.target.value)}
        />
      </label>

      <label className="field">
        <span>Mode</span>
        <select
          value={store.mode}
          onChange={(e) => store.setMode(e.target.value as Mode)}
        >
          {MODE_LABELS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      <label className="field grow">
        <span>Synthesis flags</span>
        <input
          placeholder="mode-specific, e.g. -noabc"
          title="Passed to the selected Yosys synthesis command; supported flags vary by mode."
          value={store.extraArgs}
          onChange={(e) => store.setExtraArgs(e.target.value)}
        />
      </label>

      <button
        className="primary"
        disabled={store.synthesizing}
        onClick={() => void store.synthesize()}
        title="Synthesize (Ctrl+Enter)"
      >
        {store.synthesizing ? (
          <>
            <span className="spinner" /> Synthesizing…
          </>
        ) : (
          'Synthesize'
        )}
      </button>
    </div>
  )
}
