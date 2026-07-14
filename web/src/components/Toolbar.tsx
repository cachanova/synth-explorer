import { MODE_LABELS, XILINX_FAMILY_LABELS } from '../api'
import { useStore } from '../store'
import type { Mode, XilinxFamily } from '../types'

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

      {store.mode === 'xilinx' && (
        <label className="field">
          <span>Target</span>
          <select
            value={store.xilinxFamily}
            title="Xilinx device family (synth_xilinx -family) — sets the carry/BRAM/DSP primitives to match Vivado for that part."
            onChange={(e) => store.setXilinxFamily(e.target.value as XilinxFamily)}
          >
            {XILINX_FAMILY_LABELS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {store.mode === 'xilinx' && (
        <label
          className="field checkbox"
          title="synth_xilinx -retime: move registers across logic to balance path depth (Vivado does this in some flows)."
        >
          <span>Retime</span>
          <input
            type="checkbox"
            checked={store.retime}
            onChange={(e) => store.setRetime(e.target.checked)}
          />
        </label>
      )}

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
