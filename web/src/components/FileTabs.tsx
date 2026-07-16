import { useRef, type KeyboardEvent } from 'react'
import { shallowEqual, useStore } from '../store'

export function FileTabs() {
  const store = useStore(
    ({ files, activeFileName, setActiveFileName, addFile, renameFile, deleteFile }) => ({
      files,
      activeFileName,
      setActiveFileName,
      addFile,
      renameFile,
      deleteFile,
    }),
    shallowEqual,
  )
  const tabRefs = useRef<Array<HTMLDivElement | null>>([])

  const onRename = (name: string) => {
    const next = window.prompt('Rename file', name)
    if (next && next !== name) store.renameFile(name, next)
  }

  const selectAndFocus = (index: number) => {
    const file = store.files[index]
    store.setActiveFileName(file.name)
    tabRefs.current[index]?.focus()
  }

  const deleteFileAt = (index: number, name: string) => {
    const remaining = store.files.filter((file) => file.name !== name)
    if (remaining.length === 0 || !window.confirm(`Delete ${name}?`)) return
    const deletingActiveFile = name === store.activeFileName
    const nextIndex = Math.min(index, remaining.length - 1)
    store.deleteFile(name)
    if (!deletingActiveFile) return
    store.setActiveFileName(remaining[nextIndex].name)
    window.requestAnimationFrame(() => tabRefs.current[nextIndex]?.focus())
  }

  const onTabKeyDown = (
    event: KeyboardEvent<HTMLDivElement>,
    index: number,
    name: string,
  ) => {
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % store.files.length
    if (event.key === 'ArrowLeft') {
      nextIndex = (index - 1 + store.files.length) % store.files.length
    }
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = store.files.length - 1
    if (nextIndex != null) {
      event.preventDefault()
      selectAndFocus(nextIndex)
      return
    }
    if (event.key === 'F2') {
      event.preventDefault()
      onRename(name)
      return
    }
    if (event.key === 'Delete' && store.files.length > 1) {
      event.preventDefault()
      deleteFileAt(index, name)
    }
  }

  return (
    <div className="file-tabs" role="tablist" aria-label="Source files">
      {store.files.map((f, index) => (
        <div
          key={f.name}
          ref={(node) => {
            tabRefs.current[index] = node
          }}
          className={`file-tab${f.name === store.activeFileName ? ' active' : ''}`}
          id={`source-file-tab-${index}`}
          role="tab"
          aria-label={`${f.name}. Press F2 to rename${store.files.length > 1 ? ' or Delete to delete' : ''}.`}
          aria-selected={f.name === store.activeFileName}
          aria-controls="source-editor-panel"
          tabIndex={f.name === store.activeFileName ? 0 : -1}
          onClick={() => store.setActiveFileName(f.name)}
          onDoubleClick={() => onRename(f.name)}
          onKeyDown={(event) => onTabKeyDown(event, index, f.name)}
          title="Click to open, double-click to rename"
        >
          <span>{f.name}</span>
          {store.files.length > 1 && (
            <span
              className="x"
              title="Delete file"
              aria-hidden="true"
              onClick={(e) => {
                e.stopPropagation()
                deleteFileAt(index, f.name)
              }}
            >
              ×
            </span>
          )}
        </div>
      ))}
      <button className="add" title="Add file" onClick={() => store.addFile()}>
        +
      </button>
    </div>
  )
}
