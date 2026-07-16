import { useEffect, useMemo, useRef, useState } from 'react'
import { flagsForTool, type FlagDef } from '../lib/flagRegistry'
import { getFlagValue, hasFlag, setFlagValue, toggleFlag } from '../lib/synthFlags'
import type { Mode, SynthTool } from '../types'

/** Inline editor for a value-taking flag. Fixed Vivado choices use a select;
 * integer flags keep a local draft so the user can clear and retype without
 * temporarily removing the flag. Editing never toggles the containing row. */
function ValueField({
  definition,
  value,
  onCommit,
}: {
  definition: Extract<FlagDef, { value: 'int' | 'select' }>
  value: string
  onCommit: (v: string) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])

  if (definition.value === 'select') {
    return (
      <select
        className="flags-menu-value flags-menu-choice"
        aria-label={`${definition.flag} value`}
        value={value}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onChange={(event) => onCommit(event.target.value)}
      >
        {definition.choices.map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </select>
    )
  }

  const isValid = (candidate: string) => {
    if (!/^-?\d+$/.test(candidate)) return false
    const parsed = Number(candidate)
    return (
      (definition.min === undefined || parsed >= definition.min) &&
      (definition.max === undefined || parsed <= definition.max)
    )
  }

  return (
    <input
      className="flags-menu-value"
      type="number"
      aria-label={`${definition.flag} value`}
      min={definition.min}
      max={definition.max}
      value={draft}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onBlur={() => setDraft(value)}
      onChange={(e) => {
        setDraft(e.target.value)
        if (isValid(e.target.value)) onCommit(e.target.value)
      }}
    />
  )
}

function isActive(flags: string, def: FlagDef): boolean {
  return def.value ? getFlagValue(flags, def.flag) !== null : hasFlag(flags, def.flag)
}

/**
 * Searchable multi-select for the current mode's synthesis flags. It edits the
 * shared flags string (extra_args); the free-form input stays the source of
 * truth and reflects everything selected here.
 */
export function FlagsMenu({
  tool,
  mode,
  flags,
  onChange,
}: {
  tool: SynthTool
  mode: Mode
  flags: string
  onChange: (flags: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement | null>(null)

  const defs = flagsForTool(tool, mode)
  const activeCount = useMemo(
    () => defs.filter((d) => isActive(flags, d)).length,
    [defs, flags],
  )
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return defs
    return defs.filter((d) =>
      `${d.flag} ${d.label} ${d.description}`.toLowerCase().includes(q),
    )
  }, [defs, query])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (defs.length === 0) return null

  const toggle = (def: FlagDef) => {
    const active = isActive(flags, def)
    if (def.value) {
      onChange(setFlagValue(flags, def.flag, active ? '' : def.defaultValue))
    } else {
      onChange(toggleFlag(flags, def.flag, !active))
    }
  }

  return (
    <div className="field flags-menu" ref={ref}>
      <span>Flags</span>
      <button
        type="button"
        className="flags-menu-trigger"
        onClick={() => setOpen((o) => !o)}
        title="Add or remove synthesis flags for this mode"
      >
        {activeCount > 0 ? `${activeCount} selected` : 'none'} ▾
      </button>
      {open && (
        <div className="flags-menu-popover">
          <input
            className="flags-menu-search"
            autoFocus
            placeholder="Search flags…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="flags-menu-list">
            {filtered.length === 0 && (
              <div className="flags-menu-empty">no matching flags</div>
            )}
            {filtered.map((def) => {
              const active = isActive(flags, def)
              return (
                <div
                  key={def.flag}
                  className={`flags-menu-row${active ? ' active' : ''}`}
                >
                  <label className="flags-menu-toggle">
                    <input
                      type="checkbox"
                      checked={active}
                      aria-label={`Enable ${def.flag}`}
                      onChange={() => toggle(def)}
                    />
                    <div className="flags-menu-text">
                      <div className="flags-menu-head">
                        <code>{def.flag}</code>
                        <span className="flags-menu-label">{def.label}</span>
                      </div>
                      <div className="flags-menu-desc">
                        {def.description}
                        {def.warn && (
                          <span className="flags-menu-warn"> ⚠ {def.warn}</span>
                        )}
                      </div>
                    </div>
                  </label>
                  {def.value && active && (
                    <ValueField
                      definition={def}
                      value={getFlagValue(flags, def.flag) ?? ''}
                      onCommit={(v) => onChange(setFlagValue(flags, def.flag, v))}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
