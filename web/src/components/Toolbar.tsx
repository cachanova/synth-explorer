import { useMemo, useState } from 'react'
import { PLATFORM_LABELS, SYNTH_TOOL_LABELS, XILINX_FAMILY_LABELS } from '../api'
import { parseFamily, setFamily } from '../lib/synthFlags'
import type { ExampleLanguage, Mode, SynthTool, XilinxFamily } from '../types'
import { shallowEqual, useStore } from '../useStore'
import { BubbleLoader } from './BubbleLoader'
import { FlagsMenu } from './FlagsMenu'
import { VivadoSetupDialog } from './VivadoSetupDialog'

interface FamilyBucket {
  key: string
  label: string
  rank: number
}

function familyBucket(family: string): FamilyBucket {
  const normalized = family.toLowerCase()
  if (normalized.includes('uplus')) {
    return { key: 'ultrascale_plus', label: 'UltraScale+', rank: 30 }
  }
  if (normalized.endsWith('u')) {
    return { key: 'ultrascale', label: 'UltraScale', rank: 20 }
  }
  if (normalized.endsWith('7') || normalized.endsWith('7l') || normalized === 'zynq') {
    return { key: 'series7', label: 'Series 7', rank: 10 }
  }
  if (normalized.endsWith('6')) {
    return { key: 'series6', label: 'Series 6', rank: 40 }
  }
  return {
    key: normalized,
    label: family
      .replace(/[_-]+/g, ' ')
      .replace(/\b[a-z]/g, (character) => character.toUpperCase()),
    rank: 100,
  }
}

export function Toolbar() {
  const [exampleLanguage, setExampleLanguage] = useState<ExampleLanguage>('verilog')
  const [selectedExample, setSelectedExample] = useState('')
  const [setupOpen, setSetupOpen] = useState(false)
  const store = useStore(
    ({
      examples,
      loadExample,
      top,
      setTop,
      synthTool,
      setSynthTool,
      mode,
      setMode,
      extraArgs,
      setExtraArgs,
      autoSynthesize,
      vivadoStatus,
      vivadoTarget,
      setVivadoTarget,
      vivadoExtraArgs,
      setVivadoExtraArgs,
      connectVivado,
      disconnectVivado,
      synthesizing,
      synthesize,
    }) => ({
      examples,
      loadExample,
      top,
      setTop,
      synthTool,
      setSynthTool,
      mode,
      setMode,
      extraArgs,
      setExtraArgs,
      autoSynthesize,
      vivadoStatus,
      vivadoTarget,
      setVivadoTarget,
      vivadoExtraArgs,
      setVivadoExtraArgs,
      connectVivado,
      disconnectVivado,
      synthesizing,
      synthesize,
    }),
    shallowEqual,
  )

  const familyOptions = useMemo(() => {
    const groups = new Map<FamilyBucket['key'], FamilyBucket & { parts: NonNullable<typeof store.vivadoStatus>['parts'] }>()
    for (const part of store.vivadoStatus?.parts ?? []) {
      const bucket = familyBucket(part.family)
      const existing = groups.get(bucket.key)
      if (existing) existing.parts.push(part)
      else groups.set(bucket.key, { ...bucket, parts: [part] })
    }
    return [...groups.values()]
      .map((group) => ({
        ...group,
        parts: group.parts.sort((left, right) =>
          left.name.localeCompare(right.name, undefined, { numeric: true }),
        ),
      }))
      .sort((left, right) => left.rank - right.rank || left.label.localeCompare(right.label))
  }, [store.vivadoStatus])

  const selectedPart = store.vivadoStatus?.parts.find(
    (part) => part.name === store.vivadoTarget,
  )
  const selectedFamily = selectedPart ? familyBucket(selectedPart.family).key : ''
  const familyParts = familyOptions.find((option) => option.key === selectedFamily)?.parts ?? []
  const selectedSpeed = selectedPart?.speed ?? ''
  const speeds = [...new Set(familyParts.map((part) => part.speed))].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
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
          placeholder={store.synthTool === 'vivado' ? 'required' : 'auto-detect'}
          title={store.synthTool === 'vivado'
            ? 'Local Vivado synthesis requires an explicit top module or entity.'
            : 'Verilog can auto-detect when blank; VHDL requires an explicit entity.'}
          value={store.top}
          onChange={(event) => store.setTop(event.target.value)}
        />
      </label>

      <label className="field">
        <span>Tool</span>
        <select
          aria-label="Synthesis tool"
          value={store.synthTool}
          onChange={(event) => {
            const tool = event.target.value as SynthTool
            if (tool === 'vivado' && !store.vivadoStatus) {
              void store.connectVivado().then((connected) => {
                if (connected) store.setSynthTool('vivado')
                else setSetupOpen(true)
              })
              return
            }
            store.setSynthTool(tool)
          }}
        >
          {SYNTH_TOOL_LABELS.map((tool) => (
            <option key={tool.value} value={tool.value}>{tool.label}</option>
          ))}
        </select>
      </label>

      {store.synthTool === 'yosys' && (
        <label className="field">
          <span>Platform</span>
          <select value={store.mode} onChange={(event) => store.setMode(event.target.value as Mode)}>
            {PLATFORM_LABELS.map((mode) => (
              <option key={mode.value} value={mode.value}>{mode.label}</option>
            ))}
          </select>
        </label>
      )}

      {store.synthTool === 'yosys' && store.mode === 'xilinx' && (
        <label className="field">
          <span>Target</span>
          <select
            value={parseFamily(store.extraArgs)}
            title="Xilinx device family; writes -family into the visible Yosys flags."
            onChange={(event) => store.setExtraArgs(
              setFamily(store.extraArgs, event.target.value as XilinxFamily),
            )}
          >
            {XILINX_FAMILY_LABELS.map((family) => (
              <option key={family.value} value={family.value}>{family.label}</option>
            ))}
          </select>
        </label>
      )}

      {store.synthTool === 'vivado' && (
        <>
          <label className="field">
            <span>Family</span>
            <select
              value={selectedFamily}
              onChange={(event) => {
                const group = familyOptions.find((option) => option.key === event.target.value)
                const next = group?.parts.find((part) => part.speed === selectedSpeed) ?? group?.parts[0]
                if (next) store.setVivadoTarget(next.name)
              }}
            >
              {familyOptions.map((option) => (
                <option key={option.key} value={option.key}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Speed grade</span>
            <select
              value={selectedSpeed}
              title={`Resolved local part: ${store.vivadoTarget}`}
              onChange={(event) => {
                const next = familyParts.find((part) => part.speed === event.target.value)
                if (next) store.setVivadoTarget(next.name)
              }}
            >
              {speeds.map((speed) => <option key={speed} value={speed}>{speed}</option>)}
            </select>
          </label>
          <label className="field grow">
            <span>Vivado flags</span>
            <input
              placeholder="optional synth_design flags"
              value={store.vivadoExtraArgs}
              onChange={(event) => store.setVivadoExtraArgs(event.target.value)}
            />
          </label>
          <button type="button" onClick={() => setSetupOpen(true)} title="Local Vivado connection">
            Connected
          </button>
          <button
            type="button"
            className="primary synthesize-button"
            disabled={store.synthesizing || !store.top.trim()}
            onClick={() => void store.synthesize()}
            title={store.top.trim() ? 'Run synthesis in local Vivado' : 'Enter the top module or entity first'}
          >
            {store.synthesizing ? (
              <span className="synth-button-content">
                <BubbleLoader size={16} tone="mono" /> Synthesizing…
              </span>
            ) : 'Synthesize'}
          </button>
        </>
      )}

      {store.synthTool === 'yosys' && (
        <>
          <FlagsMenu mode={store.mode} flags={store.extraArgs} onChange={store.setExtraArgs} />
          <label className="field grow">
            <span>Synthesis flags</span>
            <input
              placeholder="platform-specific, e.g. -noabc"
              title="The exact flags passed to the selected Yosys synthesis command for this platform."
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
        </>
      )}

      <VivadoSetupDialog
        open={setupOpen}
        status={store.vivadoStatus}
        onClose={() => setSetupOpen(false)}
        onConnect={async () => {
          const connected = await store.connectVivado()
          if (connected) store.setSynthTool('vivado')
          return connected
        }}
        onDisconnect={store.disconnectVivado}
      />
    </div>
  )
}
