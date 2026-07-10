import { useEffect, useState } from 'react'
import { ApiRequestError } from '../api'

export interface AsyncData<T> {
  data: T | null
  loading: boolean
  error: string | null
}

/**
 * Fetch design-scoped data, re-running whenever `id` (or `dep`) changes.
 * Returns null data until loaded. Safe against out-of-order responses.
 */
export function useDesignData<T>(
  id: string | null | undefined,
  fetcher: (id: string) => Promise<T>,
  dep: unknown = null,
): AsyncData<T> {
  const [state, setState] = useState<AsyncData<T>>({
    data: null,
    loading: false,
    error: null,
  })

  useEffect(() => {
    if (!id) {
      setState({ data: null, loading: false, error: null })
      return
    }
    let cancelled = false
    // Design-local node ids cannot be carried across analyses. Clear the old
    // payload before fetching so retained rows cannot issue a request against
    // the replacement design with stale numeric ids.
    setState({ data: null, loading: true, error: null })
    fetcher(id)
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: null })
      })
      .catch((e) => {
        if (cancelled) return
        const msg = e instanceof ApiRequestError ? e.message : String(e)
        setState({ data: null, loading: false, error: msg })
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, dep])

  return state
}
