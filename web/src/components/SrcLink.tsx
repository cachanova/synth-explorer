import { useStore } from '../store'
import { designSrcSpans, spansSummary } from '../lib/src'

/** A clickable yosys src reference that highlights the range in the editor. */
export function SrcLink({ src }: { src?: string | null }) {
  const store = useStore()
  const spans = designSrcSpans(src, store.files)
  const summary = spansSummary(spans)
  if (!summary) return null
  return (
    <a
      className="src-link"
      title={src ?? undefined}
      onClick={(e) => {
        e.stopPropagation()
        store.highlightSources(spans)
      }}
    >
      {summary}
    </a>
  )
}
