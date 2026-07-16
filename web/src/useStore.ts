import { useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { Store } from './store'
import { StoreContext } from './storeContext'

export function shallowEqual<T extends object>(left: T, right: T): boolean {
  if (Object.is(left, right)) return true
  const leftKeys = Object.keys(left) as Array<keyof T>
  const rightKeys = Object.keys(right)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.hasOwn(right, key) && Object.is(left[key], right[key]))
  )
}

export function useStore<Selection>(
  selector: (store: Store) => Selection,
  isEqual: (left: Selection, right: Selection) => boolean = Object.is,
): Selection {
  const api = useContext(StoreContext)
  if (!api) throw new Error('useStore must be used within StoreProvider')
  const committed = useRef<{ hasValue: boolean; value: Selection }>({
    hasValue: false,
    value: undefined as Selection,
  })
  const getSelection = useMemo(() => {
    let hasMemo = false
    let memoizedStore: Store
    let memoizedSelection: Selection
    return () => {
      const nextStore = api.getSnapshot()
      if (hasMemo && Object.is(memoizedStore, nextStore)) return memoizedSelection
      const nextSelection = selector(nextStore)
      if (
        (hasMemo && isEqual(memoizedSelection, nextSelection)) ||
        (!hasMemo && committed.current.hasValue && isEqual(committed.current.value, nextSelection))
      ) {
        memoizedStore = nextStore
        memoizedSelection = hasMemo ? memoizedSelection : committed.current.value
        hasMemo = true
        return memoizedSelection
      }
      hasMemo = true
      memoizedStore = nextStore
      memoizedSelection = nextSelection
      return memoizedSelection
    }
  }, [api, isEqual, selector])
  const selection = useSyncExternalStore(api.subscribe, getSelection, getSelection)
  useEffect(() => {
    committed.current = { hasValue: true, value: selection }
  }, [selection])
  return selection
}
