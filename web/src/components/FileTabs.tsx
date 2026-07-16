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

  const onRename = (name: string) => {
    const next = window.prompt('Rename file', name)
    if (next && next !== name) store.renameFile(name, next)
  }

  return (
    <div className="file-tabs" role="tablist">
      {store.files.map((f) => (
        <div
          key={f.name}
          className={`file-tab${f.name === store.activeFileName ? ' active' : ''}`}
          onClick={() => store.setActiveFileName(f.name)}
          onDoubleClick={() => onRename(f.name)}
          title="Click to open, double-click to rename"
        >
          <span>{f.name}</span>
          {store.files.length > 1 && (
            <button
              className="x"
              title="Delete file"
              onClick={(e) => {
                e.stopPropagation()
                if (window.confirm(`Delete ${f.name}?`)) store.deleteFile(f.name)
              }}
            >
              ×
            </button>
          )}
        </div>
      ))}
      <button className="add" title="Add file" onClick={() => store.addFile()}>
        +
      </button>
    </div>
  )
}
