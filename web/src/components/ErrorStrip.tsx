import { useStore } from '../useStore'

export function ErrorStrip() {
  const err = useStore((store) => store.error)
  if (!err) return null

  const kind =
    err.status === 422
      ? 'Validation error'
      : err.status === 504
        ? 'Timeout'
        : err.status === 400
          ? 'Synthesis failed'
          : 'Error'
  const summary = `${kind}${err.status ? ` (${err.status})` : ''}: ${err.message}`

  return (
    <div className="error-strip" role="alert">
      {err.log ? (
        <details className="error-details">
          <summary className="error-summary" title={summary}>
            <span className="error-mark" aria-hidden="true">
              !
            </span>
            <span className="error-summary-text">{summary}</span>
            <span className="error-log-label">log</span>
          </summary>
          <pre>{err.log}</pre>
        </details>
      ) : (
        <div className="error-summary" title={summary}>
          <span className="error-mark" aria-hidden="true">
            !
          </span>
          <span className="error-summary-text">{summary}</span>
        </div>
      )}
    </div>
  )
}
