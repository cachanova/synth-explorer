import { useStore } from '../useStore'
import { SynthIcon } from './BubbleLoader'

const KIND_BY_STATUS: Record<number, string> = {
  400: 'Synthesis failed',
  422: 'Validation error',
  503: 'Engine failed to load',
  504: 'Timeout',
}

export function ErrorStrip() {
  const err = useStore((store) => store.error)
  if (!err) return null

  const kind = (err.status && KIND_BY_STATUS[err.status]) || 'Error'
  const summary = `${kind}${err.status ? ` (${err.status})` : ''}: ${err.message}`

  return (
    <div className="error-strip" role="alert">
      {err.log ? (
        <details className="error-details">
          <summary className="error-summary" title={summary}>
            <SynthIcon size={18} tone="mono" />
            <span className="error-summary-text">{summary}</span>
            <span className="error-log-label">log</span>
          </summary>
          <pre>{err.log}</pre>
        </details>
      ) : (
        <div className="error-summary" title={summary}>
          <SynthIcon size={18} tone="mono" />
          <span className="error-summary-text">{summary}</span>
        </div>
      )}
    </div>
  )
}
