import { useState } from 'react'
import { MODE_LABELS, XILINX_FAMILY_LABELS } from '../api'
import { parseFamily, setFamily } from '../lib/synthFlags'
import type { ExampleLanguage, Mode, XilinxFamily } from '../types'
import { shallowEqual, useStore } from '../useStore'
import { FlagsMenu } from './FlagsMenu'

export function Toolbar() {
  const [exampleLanguage, setExampleLanguage] = useState<ExampleLanguage>('verilog')
  const [selectedExample, setSelectedExample] = useState('')
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
      autoSynthesize,
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
      autoSynthesize,
      synthesizing,
      synthesize,
    }),
    shallowEqual,
  )

  return (
    <div className="toolbar">
      <label className="field">
        <span>Language</span>
        <select
          aria-label="Language"
          value={exampleLanguage}
          onChange={(event) => {
            const language = event.target.value as ExampleLanguage
            setExampleLanguage(language)
            const example = store.examples.find((entry) => entry.name === selectedExample)
            if (example) store.loadExample(example.variants[language])
          }}
        >
          <option value="verilog">Verilog</option>
          <option value="vhdl">VHDL</option>
        </select>
      </label>

      <label className="field">
        <span>Example</span>
        <select
          aria-label="Bundled example"
          value={selectedExample}
          onChange={(event) => {
            setSelectedExample(event.target.value)
            const example = store.examples.find((entry) => entry.name === event.target.value)
            if (example) store.loadExample(example.variants[exampleLanguage])
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
        <span>Top module/entity</span>
        <input
          style={{ width: 110 }}
          placeholder="auto-detect"
          title="Name the top module or entity. Verilog can auto-detect when blank; VHDL requires an explicit entity."
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
      {!store.autoSynthesize && (
        <button
          type="button"
          className="primary synthesize-button"
          disabled={store.synthesizing}
          onClick={() => void store.synthesize()}
        >
          {store.synthesizing ? 'Synthesizing…' : 'Synthesize'}
        </button>
      )}
    </div>
  )
}
