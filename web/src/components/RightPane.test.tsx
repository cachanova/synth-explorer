import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../store', () => ({
  shallowEqual: Object.is,
  useStore: () => ({
    activeTab: 'overview',
    setActiveTab: vi.fn(),
    snapshotA: null,
    snapshotB: null,
  }),
}))
vi.mock('./tabs/Compare', () => ({ Compare: () => null }))
vi.mock('./tabs/Endpoints', () => ({ Endpoints: () => null }))
vi.mock('./tabs/Fanout', () => ({ Fanout: () => null }))
vi.mock('./tabs/Graph', () => ({ Graph: () => null }))
vi.mock('./tabs/Overview', () => ({ Overview: () => null }))
vi.mock('./tabs/Paths', () => ({ Paths: () => null }))

import { RightPane } from './RightPane'

describe('RightPane tabs', () => {
  it('uses one selected tab stop and links tabs to their panels', () => {
    const markup = renderToStaticMarkup(<RightPane />)
    const tabs = markup.match(/<button[^>]*role="tab"[^>]*>/g) ?? []

    expect(tabs).toHaveLength(6)
    expect(tabs.filter((tab) => tab.includes('aria-selected="true"'))).toHaveLength(1)
    expect(tabs.filter((tab) => tab.includes('tabindex="0"'))).toHaveLength(1)
    expect(tabs.filter((tab) => tab.includes('tabindex="-1"'))).toHaveLength(5)
    expect(markup).toContain('role="tabpanel"')
    expect(markup).toContain('aria-labelledby="analysis-tab-overview"')
  })
})
