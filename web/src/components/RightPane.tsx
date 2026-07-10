import { useStore, type TabId } from '../store'
import { Compare } from './tabs/Compare'
import { Endpoints } from './tabs/Endpoints'
import { Fanout } from './tabs/Fanout'
import { Graph } from './tabs/Graph'
import { Overview } from './tabs/Overview'
import { Paths } from './tabs/Paths'

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'endpoints', label: 'Endpoints' },
  { id: 'paths', label: 'Paths' },
  { id: 'fanout', label: 'Fanout' },
  { id: 'graph', label: 'Graph' },
  { id: 'compare', label: 'Compare' },
]

export function RightPane() {
  const store = useStore()
  const active = store.activeTab
  const snaps = (store.snapshotA ? 1 : 0) + (store.snapshotB ? 1 : 0)

  return (
    <div className="pane-right">
      <div className="tab-bar" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab${active === t.id ? ' active' : ''}`}
            onClick={() => store.setActiveTab(t.id)}
          >
            {t.label}
            {t.id === 'compare' && snaps > 0 && <span className="badge">{snaps}/2</span>}
          </button>
        ))}
      </div>

      {active === 'graph' ? (
        // Graph owns full height (no scroll padding).
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <Graph />
        </div>
      ) : (
        <div className="tab-body">
          {active === 'overview' && <Overview />}
          {active === 'endpoints' && <Endpoints />}
          {active === 'paths' && <Paths />}
          {active === 'fanout' && <Fanout />}
          {active === 'compare' && <Compare />}
        </div>
      )}
    </div>
  )
}
