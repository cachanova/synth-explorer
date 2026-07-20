import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { PALETTES, type Mode } from '../lib/palettes'
import { useTheme } from '../lib/themeContext'
import { clearLocalSynthesisCache } from '../lib/designCache'
import {
  AUTO_SYNTHESIS_DELAY_STEP_MS,
  formatSynthesisDelay,
  MAX_AUTO_SYNTHESIS_DELAY_MS,
  MIN_AUTO_SYNTHESIS_DELAY_MS,
} from '../lib/synthesisSettings'
import { shallowEqual, useStore } from '../useStore'

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 13a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  )
}

const MODE_META: { id: Mode; label: string; icon: ReactNode }[] = [
  {
    id: 'system',
    label: 'System',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="2" y="4" width="20" height="14" rx="2" />
        <path d="M8 21h8M12 18v3" />
      </svg>
    ),
  },
  {
    id: 'light',
    label: 'Light',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    ),
  },
  {
    id: 'dark',
    label: 'Dark',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
      </svg>
    ),
  },
]

export function SettingsMenu() {
  const { palette, mode, resolvedMode, setPalette, setMode } = useTheme()
  const store = useStore(
    ({
      confirmWorkspaceReset,
      setConfirmWorkspaceReset,
      editorKeymap,
      setEditorKeymap,
      editorLineNumbers,
      setEditorLineNumbers,
      autoSynthesize,
      setAutoSynthesize,
      autoSynthesisDelayMs,
      setAutoSynthesisDelayMs,
    }) => ({
      confirmWorkspaceReset,
      setConfirmWorkspaceReset,
      editorKeymap,
      setEditorKeymap,
      editorLineNumbers,
      setEditorLineNumbers,
      autoSynthesize,
      setAutoSynthesize,
      autoSynthesisDelayMs,
      setAutoSynthesisDelayMs,
    }),
    shallowEqual,
  )
  const [open, setOpen] = useState(false)
  const [cacheStatus, setCacheStatus] = useState<'idle' | 'clearing' | 'cleared' | 'failed'>('idle')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="settings-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="settings-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="Settings"
        title="Settings"
        onClick={() => setOpen((v) => !v)}
      >
        <GearIcon />
      </button>

      {open && (
        <div className="settings-popover" id={menuId} role="dialog" aria-label="Settings">
          <div className="settings-section">
            <div className="settings-head">Appearance</div>
            <div className="seg" role="radiogroup" aria-label="Appearance mode">
              {MODE_META.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={mode === m.id}
                  className={`seg-btn${mode === m.id ? ' active' : ''}`}
                  onClick={() => setMode(m.id)}
                >
                  <span className="seg-ic">{m.icon}</span>
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-head">Synthesis</div>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={store.autoSynthesize}
                onChange={(event) => store.setAutoSynthesize(event.target.checked)}
              />
              Synthesize automatically
            </label>
            <label className="settings-range">
              <span>
                Delay before compiling
                <span className="settings-delay-value">
                  {formatSynthesisDelay(store.autoSynthesisDelayMs)}
                </span>
              </span>
              <input
                type="range"
                aria-label="Automatic synthesis delay"
                min={MIN_AUTO_SYNTHESIS_DELAY_MS}
                max={MAX_AUTO_SYNTHESIS_DELAY_MS}
                step={AUTO_SYNTHESIS_DELAY_STEP_MS}
                value={store.autoSynthesisDelayMs}
                onChange={(event) =>
                  store.setAutoSynthesisDelayMs(Number(event.target.value))
                }
              />
            </label>
          </div>

          <div className="settings-section">
            <div className="settings-head">Editor</div>
            <div className="settings-option-label">Keybindings</div>
            <div
              className="seg editor-keymap-seg"
              role="radiogroup"
              aria-label="Editor keybindings"
            >
              {(['standard', 'vim'] as const).map((keymap) => {
                const label = keymap === 'standard' ? 'Standard' : 'Vim'
                return (
                  <button
                    key={keymap}
                    type="button"
                    role="radio"
                    aria-checked={store.editorKeymap === keymap}
                    className={`seg-btn${
                      store.editorKeymap === keymap ? ' active' : ''
                    }`}
                    onClick={() => store.setEditorKeymap(keymap)}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
            <div className="settings-option-label">Line numbers</div>
            <div className="seg" role="radiogroup" aria-label="Editor line numbers">
              {(['regular', 'relative', 'hybrid'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={store.editorLineNumbers === mode}
                  className={`seg-btn${
                    store.editorLineNumbers === mode ? ' active' : ''
                  }`}
                  onClick={() => store.setEditorLineNumbers(mode)}
                >
                  {mode[0].toUpperCase() + mode.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-head">Theme</div>
            <div className="pal-list" role="radiogroup" aria-label="Color theme">
              {PALETTES.map((p) => {
                const selected = palette === p.id
                const dimmedLight = !p.hasLight && resolvedMode === 'light'
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={`pal-row${selected ? ' active' : ''}`}
                    onClick={() => setPalette(p.id)}
                  >
                    <span className="pal-swatch" aria-hidden="true" style={{ background: p.swatch.ground }}>
                      <span style={{ background: p.swatch.accent }} />
                      <span style={{ background: p.swatch.port }} />
                      <span style={{ background: p.swatch.reg }} />
                    </span>
                    <span className="pal-text">
                      <span className="pal-name">
                        {p.label}
                        {!p.hasLight && <span className="pal-tag">dark only</span>}
                      </span>
                      <span className="pal-blurb">
                        {dimmedLight ? 'no light variant — stays dark' : p.blurb}
                      </span>
                    </span>
                    {selected && (
                      <svg className="pal-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-head">Local data</div>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={store.confirmWorkspaceReset}
                onChange={(event) => store.setConfirmWorkspaceReset(event.target.checked)}
              />
              Confirm before resetting editor
            </label>
            <button
              type="button"
              className="cache-clear"
              disabled={cacheStatus === 'clearing'}
              onClick={() => {
                setCacheStatus('clearing')
                void clearLocalSynthesisCache().then(
                  () => setCacheStatus('cleared'),
                  () => setCacheStatus('failed'),
                )
              }}
            >
              {cacheStatus === 'clearing' ? 'Clearing…' : 'Clear synthesis cache'}
            </button>
            <span className="cache-status" role="status">
              {cacheStatus === 'cleared'
                ? 'Cleared from this browser.'
                : cacheStatus === 'failed'
                  ? 'Could not clear local data.'
                  : 'Cached only in this browser profile.'}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
