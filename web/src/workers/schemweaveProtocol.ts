import type {
  ExpandedGroupLayout,
  LayoutGeometry,
  LayoutInput,
  SchemWeaveSnapshot,
} from '../lib/layout'
import type {
  SchemWeaveErrorKind,
  SchemWeaveExpansionResponse,
} from './schemweaveRuntime'

export type SchemWeaveWorkerRequest =
  | {
      id: number
      kind: 'layout'
      input: LayoutInput
    }
  | {
      id: number
      kind: 'expand'
      snapshot: SchemWeaveSnapshot
      input: LayoutInput
      group: ExpandedGroupLayout
      activeGroups: ExpandedGroupLayout[]
    }
  | {
      id: number
      kind: 'collapse'
      snapshot: SchemWeaveSnapshot
      expandedInput: LayoutInput
      compactInput: LayoutInput
      group: ExpandedGroupLayout
      activeGroups: ExpandedGroupLayout[]
    }

export type SchemWeaveWorkerResult =
  | {
      status: 'layout'
      geometry: LayoutGeometry
      degraded: boolean
    }
  | Extract<SchemWeaveExpansionResponse, { status: 'needs_full_relayout' }>

export type SchemWeaveWorkerResponse =
  | {
      id: number
      ok: true
      result: SchemWeaveWorkerResult
    }
  | {
      id: number
      ok: false
      error: string
      kind?: SchemWeaveErrorKind
    }
