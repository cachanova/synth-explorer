import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import {
  computerFileCollisions,
  readComputerFiles,
  saveComputerFile,
  saveComputerFiles,
} from '../lib/computerFiles'
import { SOURCE_FILE_ACCEPT } from '../lib/sourceFiles'
import type { DesignFile } from '../types'
import { shallowEqual, useStore } from '../useStore'

type FileAction = {
  kind: 'rename' | 'delete'
  name: string
  index: number
}

type PendingImport = {
  files: DesignFile[]
  collisions: string[]
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v6M14 11v6" />
    </svg>
  )
}

function OpenFileIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h6l2 2h10v10H3z" />
      <path d="M12 11v5M9.5 13.5H14.5" />
    </svg>
  )
}

function SaveIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 3h12l2 2v16H5zM8 3v6h8V3M8 21v-7h8v7" />
    </svg>
  )
}

function SaveAllIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 3h10l2 2v16H7zM10 3v6h6V3M10 21v-7h6v7" />
      <path d="M4 6v12" />
    </svg>
  )
}

export function FileTabs() {
  const store = useStore(
    ({
      files,
      activeFileName,
      setActiveFileName,
      addFile,
      importFiles,
      renameFile,
      deleteFile,
      resetWorkspace,
      confirmWorkspaceReset,
      setConfirmWorkspaceReset,
    }) => ({
      files,
      activeFileName,
      setActiveFileName,
      addFile,
      importFiles,
      renameFile,
      deleteFile,
      resetWorkspace,
      confirmWorkspaceReset,
      setConfirmWorkspaceReset,
    }),
    shallowEqual,
  )
  const tabRefs = useRef<Array<HTMLDivElement | null>>([])
  const filesRef = useRef(store.files)
  filesRef.current = store.files
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  const computerFileInputRef = useRef<HTMLInputElement | null>(null)
  const loadButtonRef = useRef<HTMLButtonElement | null>(null)
  const importCancelButtonRef = useRef<HTMLButtonElement | null>(null)
  const [action, setAction] = useState<FileAction | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const resetButtonRef = useRef<HTMLButtonElement | null>(null)
  const warningCheckboxRef = useRef<HTMLInputElement | null>(null)
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null)
  const [warningOpen, setWarningOpen] = useState(false)
  const [dontShowAgain, setDontShowAgain] = useState(false)
  const [transferError, setTransferError] = useState<string | null>(null)
  const [transferRunning, setTransferRunning] = useState(false)
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null)
  const warningTitleId = useId()
  const warningDescriptionId = useId()

  useEffect(() => {
    if (!pendingImport) return
    window.requestAnimationFrame(() => importCancelButtonRef.current?.focus())
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setPendingImport(null)
      window.requestAnimationFrame(() => loadButtonRef.current?.focus())
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [pendingImport])

  useEffect(() => {
    if (!warningOpen) return
    cancelButtonRef.current?.focus()
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setWarningOpen(false)
        window.requestAnimationFrame(() => resetButtonRef.current?.focus())
        return
      }
      if (event.key !== 'Tab') return
      if (event.shiftKey && document.activeElement === warningCheckboxRef.current) {
        event.preventDefault()
        confirmButtonRef.current?.focus()
      } else if (!event.shiftKey && document.activeElement === confirmButtonRef.current) {
        event.preventDefault()
        warningCheckboxRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [warningOpen])

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

  const closeWarning = () => {
    setWarningOpen(false)
    window.requestAnimationFrame(() => resetButtonRef.current?.focus())
  }

  const requestReset = () => {
    if (!store.confirmWorkspaceReset) {
      store.resetWorkspace()
      return
    }
    setDontShowAgain(false)
    setWarningOpen(true)
  }

  const confirmReset = () => {
    if (dontShowAgain) store.setConfirmWorkspaceReset(false)
    store.resetWorkspace()
    setWarningOpen(false)
    window.requestAnimationFrame(() => resetButtonRef.current?.focus())
  }

  const importComputerFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const selected = input.files
    if (!selected?.length) return
    setTransferError(null)
    setTransferRunning(true)
    try {
      const imported = await readComputerFiles(selected, store.files)
      const collisions = computerFileCollisions(filesRef.current, imported)
      if (collisions.length > 0) {
        setPendingImport({ files: imported, collisions })
      } else {
        store.importFiles(imported)
      }
    } catch (error) {
      setTransferError(
        error instanceof Error
          ? error.message
          : 'Could not load the selected files.',
      )
    } finally {
      setTransferRunning(false)
      input.value = ''
    }
  }

  const confirmImport = () => {
    if (!pendingImport) return
    const currentCollisions = computerFileCollisions(
      filesRef.current,
      pendingImport.files,
    )
    if (
      currentCollisions.some(
        (name) => !pendingImport.collisions.includes(name),
      )
    ) {
      setPendingImport({
        files: pendingImport.files,
        collisions: currentCollisions,
      })
      return
    }
    try {
      store.importFiles(pendingImport.files)
    } catch (error) {
      setTransferError(
        error instanceof Error
          ? error.message
          : 'Could not load the selected files.',
      )
    }
    setPendingImport(null)
    window.requestAnimationFrame(() => loadButtonRef.current?.focus())
  }

  const cancelImport = () => {
    setPendingImport(null)
    window.requestAnimationFrame(() => loadButtonRef.current?.focus())
  }

  const activeFile =
    store.files.find((file) => file.name === store.activeFileName) ??
    store.files[0]
  const transferDisabled = transferRunning || pendingImport != null

  const saveActiveFile = async () => {
    setTransferError(null)
    setTransferRunning(true)
    try {
      await saveComputerFile(activeFile)
    } catch (error) {
      setTransferError(
        error instanceof Error ? error.message : 'Could not save the file.',
      )
    } finally {
      setTransferRunning(false)
    }
  }

  const saveAllFiles = async () => {
    setTransferError(null)
    setTransferRunning(true)
    try {
      await saveComputerFiles(store.files)
    } catch (error) {
      setTransferError(
        error instanceof Error ? error.message : 'Could not save the files.',
      )
    } finally {
      setTransferRunning(false)
    }
  }

  return (
    <>
      <div className="file-tabs-bar">
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
        <div className="computer-file-actions">
          <input
            ref={computerFileInputRef}
            className="computer-file-input"
            type="file"
            accept={SOURCE_FILE_ACCEPT}
            multiple
            onChange={importComputerFiles}
          />
          <button
            ref={loadButtonRef}
            type="button"
            className="file-io-button"
            aria-label="Load files from computer"
            title="Load .v, .sv, or .svh files from computer"
            disabled={transferDisabled}
            onClick={() => computerFileInputRef.current?.click()}
          >
            <OpenFileIcon />
          </button>
          <button
            type="button"
            className="file-io-button"
            aria-label={`Save ${activeFile.name} to computer`}
            title={`Save ${activeFile.name} to computer`}
            disabled={transferDisabled}
            onClick={() => void saveActiveFile()}
          >
            <SaveIcon />
          </button>
          {store.files.length > 1 && (
            <button
              type="button"
              className="file-io-button"
              aria-label="Save all files to computer"
              title="Save all open files to a folder"
              disabled={transferDisabled}
              onClick={() => void saveAllFiles()}
            >
              <SaveAllIcon />
            </button>
          )}
        </div>
        <button
          ref={resetButtonRef}
          type="button"
          className="workspace-reset"
          aria-label="Reset editor"
          title="Delete all open files and reset editor"
          disabled={transferDisabled}
          onClick={requestReset}
        >
          <TrashIcon />
        </button>
      </div>

      {transferError && (
        <div className="file-transfer-error" role="alert">
          <span>{transferError}</span>
          <button
            type="button"
            aria-label="Dismiss file error"
            onClick={() => setTransferError(null)}
          >
            ×
          </button>
        </div>
      )}

      {pendingImport && (
        <div
          className="file-action-menu"
          role="dialog"
          aria-label="Replace existing files?"
        >
          <span>
            {pendingImport.collisions.length === 1
              ? `Replace ${pendingImport.collisions[0]}?`
              : `Replace ${pendingImport.collisions.length} existing files?`}
          </span>
          <button type="button" className="danger" onClick={confirmImport}>
            Replace
          </button>
          <button
            ref={importCancelButtonRef}
            type="button"
            onClick={cancelImport}
          >
            Cancel
          </button>
        </div>
      )}

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

      {warningOpen && (
        <div
          className="reset-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeWarning()
          }}
        >
          <div
            className="reset-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={warningTitleId}
            aria-describedby={warningDescriptionId}
          >
            <div className="reset-dialog-title" id={warningTitleId}>Reset editor?</div>
            <p id={warningDescriptionId}>
              This deletes all open files and restores the default <code>design.sv</code>.
              This cannot be undone.
            </p>
            <label className="reset-dialog-choice">
              <input
                ref={warningCheckboxRef}
                type="checkbox"
                checked={dontShowAgain}
                onChange={(event) => setDontShowAgain(event.target.checked)}
              />
              Don&apos;t show this warning again
            </label>
            <div className="reset-dialog-actions">
              <button ref={cancelButtonRef} type="button" onClick={closeWarning}>
                Cancel
              </button>
              <button
                ref={confirmButtonRef}
                type="button"
                className="danger"
                onClick={confirmReset}
              >
                Reset editor
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
