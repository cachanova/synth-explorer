import { useContext } from 'react'
import type { Store } from './store'
import { StoreContext } from './storeContext'

export function useStore(): Store {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useStore must be used within StoreProvider')
  return store
}
