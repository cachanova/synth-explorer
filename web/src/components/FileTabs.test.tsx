import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../useStore', () => ({
  shallowEqual: Object.is,
  useStore: () => ({
    files: [
      { name: 'top.sv', content: '' },
      { name: 'alu.sv', content: '' },
      { name: 'regs.sv', content: '' },
    ],
    activeFileName: 'alu.sv',
    setActiveFileName: vi.fn(),
    renameFile: vi.fn(),
    deleteFile: vi.fn(),
    addFile: vi.fn(),
    importFiles: vi.fn(),
    resetWorkspace: vi.fn(),
    confirmWorkspaceReset: true,
    setConfirmWorkspaceReset: vi.fn(),
  }),
}))

import { FileTabs } from './FileTabs'

describe('FileTabs', () => {
  it('uses one selected file tab stop linked to the editor panel', () => {
    const markup = renderToStaticMarkup(<FileTabs />)
    const tabs = markup.match(/<div[^>]*role="tab"[^>]*>/g) ?? []

    expect(tabs).toHaveLength(3)
    expect(tabs.filter((tab) => tab.includes('aria-selected="true"'))).toHaveLength(1)
    expect(tabs.filter((tab) => tab.includes('tabindex="0"'))).toHaveLength(1)
    expect(tabs.filter((tab) => tab.includes('tabindex="-1"'))).toHaveLength(2)
    expect(tabs.every((tab) => tab.includes('aria-controls="source-editor-panel"'))).toBe(true)
    expect(markup).toContain('aria-label="Reset editor"')
    expect(markup).toContain('aria-label="Load files from computer"')
    expect(markup).toContain('accept=".v,.sv,.svh,.vhd,.vhdl"')
    expect(markup).toContain(
      'title="Load .v, .sv, .svh, .vhd, or .vhdl files from computer"',
    )
    expect(markup).toContain('aria-label="Save alu.sv to computer"')
    expect(markup).toContain('aria-label="Save all files to computer"')
  })
})
