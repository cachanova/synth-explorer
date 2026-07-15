import {
  MODE_LABELS,
  SYNTH_TOOL_LABELS,
  VIVADO_TARGETS,
  XILINX_FAMILY_LABELS,
} from '../api'
import { parseFamily, setFamily } from '../lib/synthFlags'
import { useStore } from '../store'
import type { Mode, SynthTool, XilinxFamily } from '../types'
import { FlagsMenu } from './FlagsMenu'

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
          placeholder="auto-detect"
          title="Leave blank to auto-detect the top module (yosys hierarchy -auto-top), or name it explicitly."
          value={store.top}
          onChange={(e) => store.setTop(e.target.value)}
        />
      </label>

      <label className="field">
        <span>Synth tool</span>
        <select
          value={store.synthTool}
          onChange={(e) => {
            const tool = e.target.value as SynthTool
            if (tool !== 'vivado' || store.vivadoUnlocked) {
              store.setSynthTool(tool)
              return
            }
            const accessKey = window.prompt(
              'Enter the Vivado owner API key. It stays only in this browser tab’s memory.',
            )
            if (!accessKey) return
            void store.unlockVivado(accessKey).then((unlocked) => {
              if (unlocked) store.setSynthTool('vivado')
            })
          }}
        >
          {SYNTH_TOOL_LABELS.filter(
            (tool) => tool.value !== 'vivado' || store.vivadoAvailable,
          ).map((tool) => (
            <option key={tool.value} value={tool.value}>
              {tool.label}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Mode</span>
        <select
          value={store.synthTool === 'vivado' ? 'gates' : store.mode}
          disabled={store.synthTool === 'vivado'}
          onChange={(e) => store.setMode(e.target.value as Mode)}
        >
          {(store.synthTool === 'vivado'
            ? MODE_LABELS.filter((m) => m.value === 'gates')
            : MODE_LABELS
          ).map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      {store.synthTool === 'yosys' && store.mode === 'xilinx' && (
        <label className="field">
          <span>Target</span>
          <select
            value={parseFamily(store.extraArgs)}
            title="Xilinx device family (synth_xilinx -family) — sets the carry/BRAM/DSP primitives to match Vivado for that part. Writes -family into the synthesis flags."
            onChange={(e) =>
              store.setExtraArgs(
                setFamily(store.extraArgs, e.target.value as XilinxFamily),
              )
            }
          >
            {XILINX_FAMILY_LABELS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {store.synthTool === 'vivado' && (
        <label className="field">
          <span>Target</span>
          <select
            value={store.vivadoTarget}
            title="Vivado part passed to synth_design -part."
            onChange={(e) => store.setVivadoTarget(e.target.value)}
          >
            {VIVADO_TARGETS.map((target) => (
              <option key={target.value} value={target.value}>
                {target.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {store.synthTool === 'yosys' ? (
        <>
          <FlagsMenu
            mode={store.mode}
            flags={store.extraArgs}
            onChange={(flags) => store.setExtraArgs(flags)}
          />
          <label className="field grow">
            <span>Synthesis flags</span>
            <input
              placeholder="mode-specific, e.g. -noabc"
              title="The exact flags passed to the selected Yosys synthesis command. The Target dropdown and Flags menu edit this string; you can also type flags directly."
              value={store.extraArgs}
              onChange={(e) => store.setExtraArgs(e.target.value)}
            />
          </label>
        </>
      ) : (
        <label className="field grow">
          <span>Synthesis flags</span>
          <input
            placeholder="Vivado synth_design flags, e.g. -retiming"
            title="Validated whitespace-separated flags appended to Vivado synth_design."
            value={store.vivadoExtraArgs}
            onChange={(e) => store.setVivadoExtraArgs(e.target.value)}
          />
        </label>
      )}

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
