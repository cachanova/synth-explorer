import { createContext } from 'react'
import type { StoreApi } from './store'

export const StoreContext = createContext<StoreApi | null>(null)
