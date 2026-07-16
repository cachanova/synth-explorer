import { useRef, type KeyboardEvent } from 'react'
import type { TabId } from '../store'
import { shallowEqual, useStore } from '../useStore'
import { Endpoints } from './tabs/Endpoints'
import { Fanout } from './tabs/Fanout'
import { Graph } from './tabs/Graph'
import { Overview } from './tabs/Overview'
import { Paths } from './tabs/Paths'

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'graph', label: 'Schematic' },
  { id: 'endpoints', label: 'Endpoints' },
  { id: 'paths', label: 'Paths' },
  { id: 'fanout', label: 'Fanout' },
]

export function RightPane() {
  const store = useStore(
    ({ activeTab, setActiveTab }) => ({
      activeTab,
      setActiveTab,
    }),
    shallowEqual,
  )
  const active = store.activeTab
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const selectAndFocus = (index: number) => {
    const tab = TABS[index]
    store.setActiveTab(tab.id)
    tabRefs.current[index]?.focus()
  }

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % TABS.length
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + TABS.length) % TABS.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = TABS.length - 1
    if (nextIndex == null) return
    event.preventDefault()
    selectAndFocus(nextIndex)
  }

  return (
    <div className="pane-right">
      <div className="tab-bar" role="tablist" aria-label="Analysis views">
        {TABS.map((t, index) => (
          <button
            key={t.id}
            ref={(node) => {
              tabRefs.current[index] = node
            }}
            className={`tab${active === t.id ? ' active' : ''}`}
            id={`analysis-tab-${t.id}`}
            role="tab"
            aria-selected={active === t.id}
            aria-controls={`analysis-panel-${t.id}`}
            tabIndex={active === t.id ? 0 : -1}
            onClick={() => store.setActiveTab(t.id)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Keep Graph mounted so pan, zoom, and node selection survive tab switches. */}
      <div
        id="analysis-panel-graph"
        role="tabpanel"
        aria-labelledby="analysis-tab-graph"
        aria-hidden={active !== 'graph'}
        style={{
          flex: 1,
          minHeight: 0,
          display: active === 'graph' ? 'flex' : 'none',
        }}
      >
        <Graph active={active === 'graph'} />
      </div>

      {active !== 'graph' && (
        <div
          className="tab-body"
          id={`analysis-panel-${active}`}
          role="tabpanel"
          aria-labelledby={`analysis-tab-${active}`}
        >
          {active === 'overview' && <Overview />}
          {active === 'endpoints' && <Endpoints />}
          {active === 'paths' && <Paths />}
          {active === 'fanout' && <Fanout />}
        </div>
      )}
    </div>
  )
}
