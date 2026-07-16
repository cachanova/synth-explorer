import { useMemo, useState } from 'react'
import { MODE_LABELS, SYNTH_TOOL_LABELS, XILINX_FAMILY_LABELS } from '../api'
import { parseFamily, setFamily } from '../lib/synthFlags'
import { shallowEqual, useStore } from '../store'
import type { Mode, SynthTool, XilinxFamily } from '../types'
import { FlagsMenu } from './FlagsMenu'
import { VivadoUnlockDialog } from './VivadoUnlockDialog'

export function Toolbar() {
  const store = useStore(
    ({
      examples,
      loadExample,
      top,
      setTop,
      synthTool,
      setSynthTool,
      vivadoUnlocked,
      vivadoAvailable,
      mode,
      setMode,
      extraArgs,
      setExtraArgs,
      vivadoTargets,
      vivadoTarget,
      setVivadoTarget,
      vivadoExtraArgs,
      setVivadoExtraArgs,
      synthesizing,
      synthesize,
      unlockVivado,
    }) => ({
      examples,
      loadExample,
      top,
      setTop,
      synthTool,
      setSynthTool,
      vivadoUnlocked,
      vivadoAvailable,
      mode,
      setMode,
      extraArgs,
      setExtraArgs,
      vivadoTargets,
      vivadoTarget,
      setVivadoTarget,
      vivadoExtraArgs,
      setVivadoExtraArgs,
      synthesizing,
      synthesize,
      unlockVivado,
    }),
    shallowEqual,
  )
  const [unlockOpen, setUnlockOpen] = useState(false)
  const targetGroups = useMemo(() => {
    const groups = new Map<string, typeof store.vivadoTargets>()
    for (const part of store.vivadoTargets) {
      const existing = groups.get(part.family)
      if (existing) existing.push(part)
      else groups.set(part.family, [part])
    }
    return [...groups]
  }, [store.vivadoTargets])
  const selectedTarget = store.vivadoTargets.find(
    (part) => part.name === store.vivadoTarget,
  )
  const selectedFamily = selectedTarget?.family ?? targetGroups[0]?.[0] ?? ''
  const familyTargets =
    targetGroups.find(([family]) => family === selectedFamily)?.[1] ?? []
  const selectedSpeed = selectedTarget?.speed ?? familyTargets[0]?.speed ?? ''
  const speedGrades = [...new Set(familyTargets.map((part) => part.speed))].sort(
    (left, right) => left.localeCompare(right, undefined, { numeric: true }),
  )

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
            setUnlockOpen(true)
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

      {store.synthTool === 'yosys' && (
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
      )}

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
          <span>Family</span>
          <select
            value={selectedFamily}
            title="Filter the installed Vivado part catalog by device family."
            onChange={(event) => {
              const targets = targetGroups.find(
                ([family]) => family === event.target.value,
              )?.[1]
              const target =
                targets?.find((part) => part.speed === selectedSpeed) ?? targets?.[0]
              if (target) store.setVivadoTarget(target.name)
            }}
          >
            {targetGroups.map(([family]) => (
              <option key={family} value={family}>
                {family}
              </option>
            ))}
          </select>
        </label>
      )}

      {store.synthTool === 'vivado' && (
        <label className="field">
          <span>Speed grade</span>
          <select
            value={selectedSpeed}
            title={`Resolved Vivado part: ${store.vivadoTarget}`}
            onChange={(event) => {
              const target = familyTargets.find(
                (part) => part.speed === event.target.value,
              )
              if (target) store.setVivadoTarget(target.name)
            }}
          >
            {speedGrades.map((speed) => (
              <option key={speed} value={speed}>
                {speed}
              </option>
            ))}
          </select>
        </label>
      )}

      {store.synthTool === 'yosys' ? (
        <>
          <FlagsMenu
            tool="yosys"
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
        <>
          <FlagsMenu
            tool="vivado"
            mode="gates"
            flags={store.vivadoExtraArgs}
            onChange={(flags) => store.setVivadoExtraArgs(flags)}
          />
          <label className="field grow">
            <span>Synthesis flags</span>
            <input
              placeholder="Vivado synth_design flags, e.g. -global_retiming on"
              title="Validated whitespace-separated flags appended to Vivado synth_design. The Flags menu edits this string; you can also type advanced flags directly."
              value={store.vivadoExtraArgs}
              onChange={(e) => store.setVivadoExtraArgs(e.target.value)}
            />
          </label>
        </>
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
      <VivadoUnlockDialog
        open={unlockOpen}
        onClose={() => setUnlockOpen(false)}
        onUnlock={async (accessKey) => {
          const unlocked = await store.unlockVivado(accessKey)
          if (unlocked) store.setSynthTool('vivado')
          return unlocked
        }}
      />
    </div>
  )
}
