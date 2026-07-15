import { useEffect, useMemo, useRef, useState } from 'react'
import { flagsForTool, type FlagDef } from '../lib/flagRegistry'
import { getFlagValue, hasFlag, setFlagValue, toggleFlag } from '../lib/synthFlags'
import type { Mode, SynthTool } from '../types'

const DEFAULT_VALUES: Record<string, string> = { '-widemux': '5' }

/**
 * Inline number field for a value-taking flag. Local draft state lets the user
 * clear-and-retype without the field unmounting (only non-empty values are
 * committed to the flags string), and it swallows click/keydown so editing the
 * value never toggles the row off.
 */
function ValueField({
  value,
  onCommit,
}: {
  value: string
  onCommit: (v: string) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <input
      className="flags-menu-value"
      type="number"
      min={2}
      value={draft}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onBlur={() => setDraft(value)}
      onChange={(e) => {
        setDraft(e.target.value)
        if (e.target.value !== '') onCommit(e.target.value)
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
      if (e.key === 'Escape') setOpen(false)
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
      onChange(
        setFlagValue(flags, def.flag, active ? '' : (DEFAULT_VALUES[def.flag] ?? '1')),
      )
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
                  role="button"
                  tabIndex={0}
                  onClick={() => toggle(def)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      toggle(def)
                    }
                  }}
                >
                  <input type="checkbox" checked={active} readOnly tabIndex={-1} />
                  <div className="flags-menu-text">
                    <div className="flags-menu-head">
                      <code>{def.flag}</code>
                      <span className="flags-menu-label">{def.label}</span>
                    </div>
                    <div className="flags-menu-desc">
                      {def.description}
                      {def.warn && <span className="flags-menu-warn"> ⚠ {def.warn}</span>}
                    </div>
                  </div>
                  {def.value && active && (
                    <ValueField
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
