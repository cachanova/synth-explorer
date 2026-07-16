import { createContext } from 'react'
import type { Store } from './store'

export const StoreContext = createContext<Store | null>(null)
