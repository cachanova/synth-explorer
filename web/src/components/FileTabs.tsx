import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { shallowEqual, useStore } from '../useStore'

type FileAction = {
  kind: 'rename' | 'delete'
  name: string
  index: number
}

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
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  const [action, setAction] = useState<FileAction | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  const closeAction = (focusIndex = action?.index) => {
    setAction(null)
    if (focusIndex == null) return
    window.requestAnimationFrame(() => tabRefs.current[focusIndex]?.focus())
  }

  useEffect(() => {
    if (!action) return
    if (action.kind === 'rename') {
      window.requestAnimationFrame(() => {
        renameInputRef.current?.focus()
        renameInputRef.current?.select()
      })
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeAction(action.index)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
    // closeAction deliberately resolves the current tab ref at event time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action])

  const onRename = (index: number, name: string) => {
    store.setActiveFileName(name)
    setRenameDraft(name)
    setAction({ kind: 'rename', name, index })
  }

  const selectAndFocus = (index: number) => {
    const file = store.files[index]
    store.setActiveFileName(file.name)
    tabRefs.current[index]?.focus()
  }

  const requestDelete = (index: number, name: string) => {
    const remaining = store.files.filter((file) => file.name !== name)
    if (remaining.length === 0) return
    setAction({ kind: 'delete', name, index })
  }

  const confirmDelete = (index: number, name: string) => {
    const remaining = store.files.filter((file) => file.name !== name)
    if (remaining.length === 0) return
    const deletingActiveFile = name === store.activeFileName
    const nextIndex = Math.min(index, remaining.length - 1)
    store.deleteFile(name)
    setAction(null)
    if (!deletingActiveFile) return
    store.setActiveFileName(remaining[nextIndex].name)
    window.requestAnimationFrame(() => tabRefs.current[nextIndex]?.focus())
  }

  const cleanRename = renameDraft.trim()
  const renameIssue =
    action?.kind !== 'rename' || cleanRename === action.name
      ? null
      : !cleanRename
        ? 'Enter a file name.'
        : !/^[A-Za-z0-9._-]+$/.test(cleanRename)
          ? 'Use only letters, numbers, dots, dashes, or underscores.'
          : store.files.some(
                (file) => file.name === cleanRename && file.name !== action.name,
              )
            ? 'That file already exists.'
            : null
  const renameValid =
    action?.kind === 'rename' && cleanRename !== action.name && renameIssue == null

  const commitRename = (event: FormEvent) => {
    event.preventDefault()
    if (!action || action.kind !== 'rename' || !renameValid) return
    const index = action.index
    store.renameFile(action.name, cleanRename)
    closeAction(index)
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
      onRename(index, name)
      return
    }
    if (event.key === 'Delete' && store.files.length > 1) {
      event.preventDefault()
      requestDelete(index, name)
    }
  }

  return (
    <>
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
            onDoubleClick={() => onRename(index, f.name)}
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
                  requestDelete(index, f.name)
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
      {action?.kind === 'rename' && (
        <form
          className="file-action-menu"
          role="dialog"
          aria-label={`Rename ${action.name}`}
          onSubmit={commitRename}
        >
          <label htmlFor="rename-source-file">Rename {action.name}</label>
          <input
            ref={renameInputRef}
            id="rename-source-file"
            value={renameDraft}
            aria-invalid={renameIssue != null}
            aria-describedby={renameIssue ? 'rename-source-file-error' : undefined}
            onChange={(event) => setRenameDraft(event.target.value)}
          />
          <button type="submit" className="primary" disabled={!renameValid}>
            Rename
          </button>
          <button type="button" onClick={() => closeAction()}>
            Cancel
          </button>
          {renameIssue && (
            <span id="rename-source-file-error" className="file-action-error">
              {renameIssue}
            </span>
          )}
        </form>
      )}
      {action?.kind === 'delete' && (
        <div
          className="file-action-menu"
          role="dialog"
          aria-label={`Delete ${action.name}`}
        >
          <span>Delete {action.name}?</span>
          <button
            type="button"
            className="danger"
            onClick={() => confirmDelete(action.index, action.name)}
          >
            Delete
          </button>
          <button type="button" onClick={() => closeAction()}>
            Cancel
          </button>
        </div>
      )}
    </>
  )
}
