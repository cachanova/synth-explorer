import { useStore } from '../useStore'

export function ErrorStrip() {
  const store = useStore()
  const err = store.error
  if (!err) return null

  const kind =
    err.status === 422
      ? 'Validation error'
      : err.status === 504
        ? 'Timeout'
        : err.status === 400
          ? 'Synthesis failed'
          : 'Error'

  return (
    <div className="error-strip">
      <div className="err-title">
        <span>
          {kind}
          {err.status ? ` (${err.status})` : ''}: {err.message}
        </span>
      </div>
      {err.log && (
        <details className="collapsible" open>
          <summary>yosys log</summary>
          <pre>{err.log}</pre>
        </details>
      )}
    </div>
  )
}
