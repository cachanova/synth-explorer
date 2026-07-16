import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../useStore', () => ({
  shallowEqual: Object.is,
  useStore: () => ({
    activeTab: 'graph',
    setActiveTab: vi.fn(),
  }),
}))
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

    expect(tabs).toHaveLength(5)
    expect(markup).toMatch(
      /analysis-tab-overview[\s\S]*analysis-tab-graph[\s\S]*analysis-tab-endpoints[\s\S]*analysis-tab-paths[\s\S]*analysis-tab-fanout/,
    )
    expect(tabs.filter((tab) => tab.includes('aria-selected="true"'))).toHaveLength(1)
    expect(tabs.filter((tab) => tab.includes('tabindex="0"'))).toHaveLength(1)
    expect(tabs.filter((tab) => tab.includes('tabindex="-1"'))).toHaveLength(4)
    expect(markup).toContain('role="tabpanel"')
    expect(markup).toContain('aria-labelledby="analysis-tab-graph"')
  })
})
