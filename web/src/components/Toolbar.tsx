import { MODE_LABELS, XILINX_FAMILY_LABELS } from '../api'
import { parseFamily, setFamily } from '../lib/synthFlags'
import type { Mode, XilinxFamily } from '../types'
import { shallowEqual, useStore } from '../useStore'
import { BubbleLoader } from './BubbleLoader'
import { FlagsMenu } from './FlagsMenu'

export function Toolbar() {
  const store = useStore(
    ({
      examples,
      loadExample,
      top,
      setTop,
      mode,
      setMode,
      extraArgs,
      setExtraArgs,
      synthesizing,
      synthesize,
    }) => ({
      examples,
      loadExample,
      top,
      setTop,
      mode,
      setMode,
      extraArgs,
      setExtraArgs,
      synthesizing,
      synthesize,
    }),
    shallowEqual,
  )

  return (
    <div className="toolbar">
      <label className="field">
        <span>Example</span>
        <select
          value=""
          onChange={(event) => {
            const example = store.examples.find((entry) => entry.name === event.target.value)
            if (example) store.loadExample(example)
          }}
        >
          <option value="">{store.examples.length ? 'Load example…' : '(no examples)'}</option>
          {store.examples.map((example) => (
            <option key={example.name} value={example.name}>
              {example.title || example.name}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Top module</span>
        <input
          style={{ width: 110 }}
          placeholder="auto-detect"
          title="Leave blank to auto-detect the top module, or name it explicitly."
          value={store.top}
          onChange={(event) => store.setTop(event.target.value)}
        />
      </label>

      <label className="field">
        <span>Mode</span>
        <select value={store.mode} onChange={(event) => store.setMode(event.target.value as Mode)}>
          {MODE_LABELS.map((mode) => (
            <option key={mode.value} value={mode.value}>
              {mode.label}
            </option>
          ))}
        </select>
      </label>

      {store.mode === 'xilinx' && (
        <label className="field">
          <span>Target</span>
          <select
            value={parseFamily(store.extraArgs)}
            title="Xilinx device family; writes -family into the visible synthesis flags."
            onChange={(event) =>
              store.setExtraArgs(
                setFamily(store.extraArgs, event.target.value as XilinxFamily),
              )
            }
          >
            {XILINX_FAMILY_LABELS.map((family) => (
              <option key={family.value} value={family.value}>
                {family.label}
              </option>
            ))}
          </select>
        </label>
      )}

      <FlagsMenu
        mode={store.mode}
        flags={store.extraArgs}
        onChange={(flags) => store.setExtraArgs(flags)}
      />
      <label className="field grow">
        <span>Synthesis flags</span>
        <input
          placeholder="mode-specific, e.g. -noabc"
          title="The exact flags passed to the selected Yosys synthesis command."
          value={store.extraArgs}
          onChange={(event) => store.setExtraArgs(event.target.value)}
        />
      </label>

      <button
        className="primary"
        disabled={store.synthesizing}
        onClick={() => void store.synthesize()}
        title="Synthesize in this browser (Ctrl+Enter)"
      >
        {store.synthesizing ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <BubbleLoader size={16} tone="mono" /> Synthesizing…
          </span>
        ) : (
          'Synthesize'
        )}
      </button>
    </div>
  )
}
