import { useStore } from '../store'
import { parseSrc, srcSummary } from '../lib/src'

/** A clickable yosys src reference that highlights the range in the editor. */
export function SrcLink({ src }: { src?: string | null }) {
  const store = useStore()
  const summary = srcSummary(src)
  if (!summary) return null
  return (
    <a
      className="src-link"
      title={src ?? undefined}
      onClick={(e) => {
        e.stopPropagation()
        const spans = parseSrc(src)
        store.highlightSources(spans)
      }}
    >
      {summary}
    </a>
  )
}
