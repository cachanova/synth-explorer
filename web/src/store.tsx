import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react'
import { defaultWorkspace } from './data/defaultWorkspace'
import type { GraphOptions } from './lib/graph/graphSettings'
import type { ExampleSelection } from './lib/exampleSelection'
import type { SourceSelection } from './lib/synthesis/liveAnalysis'
import type {
  EditorKeymap,
  EditorLineNumbers,
  WorkspaceState,
} from './lib/workspaceStorage'
import type { SrcSpan } from './lib/source/src'
import type { SourceNetSelection } from './lib/source/sourceTiers'
import {
  useAnalysisStateEffect,
  useGraphRequestCleanup,
  useGraphRequestSlice,
  type EditorHighlight,
  type GraphRequest,
  type TabId,
} from './store/graphRequestSlice'
import {
  usePreferencesPersistence,
  usePreferencesSlice,
} from './store/preferencesSlice'
import {
  useSynthesisEffects,
  useSynthesisSlice,
  type AnalysisState,
  type StoreError,
} from './store/synthesisSlice'
import { useVivadoRestore, useVivadoSlice } from './store/vivadoSlice'
import {
  useWorkspacePersistence,
  useWorkspaceSlice,
} from './store/workspaceSlice'
import { StoreContext } from './storeContext'
import type {
  DesignFile,
  Example,
  ExampleVariant,
  Mode,
  SynthTool,
  SynthesizeResponse,
  TimingPath,
  VivadoBridgeStatus,
} from './types'

export type {
  ConeGraphRequest,
  EditorHighlight,
  GraphRequest,
  SourceGraphRequest,
  TabId,
} from './store/graphRequestSlice'
export type { AnalysisState } from './store/synthesisSlice'

export interface Store {
  // editor / inputs
  files: DesignFile[]
  activeFileName: string
  /** Bumped when file content is replaced outside the editor (example load). */
  docRevision: number
  top: string
  synthTool: SynthTool
  mode: Mode
  extraArgs: string
  vivadoStatus: VivadoBridgeStatus | null
  vivadoTarget: string
  vivadoExtraArgs: string
  examples: Example[]

  setActiveFileName: (name: string) => void
  updateFileContent: (name: string, content: string) => void
  addFile: () => void
  importFiles: (files: DesignFile[]) => void
  renameFile: (oldName: string, newName: string) => void
  deleteFile: (name: string) => void
  resetWorkspace: () => void
  setTop: (t: string) => void
  setSynthTool: (tool: SynthTool) => void
  setMode: (m: Mode) => void
  setExtraArgs: (a: string) => void
  setVivadoTarget: (target: string) => void
  setVivadoExtraArgs: (args: string) => void
  connectVivado: (vivadoPath?: string) => Promise<{
    connected: boolean
    error?: string
    pathRequired?: boolean
  }>
  disconnectVivado: () => void
  loadExample: (variant: ExampleVariant) => void
  exampleSelection: ExampleSelection
  setExampleSelection: (selection: ExampleSelection) => void
  confirmWorkspaceReset: boolean
  setConfirmWorkspaceReset: (enabled: boolean) => void
  editorKeymap: EditorKeymap
  setEditorKeymap: (keymap: EditorKeymap) => void
  editorLineNumbers: EditorLineNumbers
  setEditorLineNumbers: (mode: EditorLineNumbers) => void
  autoSynthesize: boolean
  setAutoSynthesize: (enabled: boolean) => void
  autoSynthesisDelayMs: number
  setAutoSynthesisDelayMs: (delayMs: number) => void

  // synthesis
  synthesizing: boolean
  synthesize: () => Promise<void>
  design: SynthesizeResponse | null
  designRevision: number
  analysisState: AnalysisState
  error: StoreError | null

  // tabs
  activeTab: TabId
  setActiveTab: (t: TabId) => void

  // graph
  coneReq: GraphRequest | null
  graphOptions: GraphOptions
  setGraphOptions: (patch: Partial<GraphOptions>) => void
  openCone: (opts: {
    node?: number
    nodes?: number[]
    dir: 'fanin' | 'fanout'
    label: string
    highlight?: number[]
    rootPort?: string
    rootPortBit?: number
    rootPortBits?: number[]
  }) => void
  openControlCone: (opts: {
    node?: number
    nodes?: number[]
    label: string
    generated?: boolean
  }) => void
  showPathInGraph: (path: TimingPath) => void
  clearGraphSelection: () => void
  registerGraphProbeReset: (reset: (() => void) | null) => void

  // cross-probe: graph node src -> editor highlight
  editorHighlight: EditorHighlight | null
  highlightSources: (spans: SrcSpan[]) => void
  selectSchematicNodes: (nodeIds: number[]) => void
  selectSchematicNets: (selection: SourceNetSelection) => void

  // cross-probe: editor -> graph nodes
  sourceSelection: SourceSelection
  setSourceSelection: (
    file: string,
    startLine: number,
    endLine: number,
    startColumn?: number,
    endColumn?: number,
    fallbackStartColumn?: number,
    fallbackEndColumn?: number,
  ) => void
}

export interface StoreApi {
  getSnapshot(): Store
  publish(next: Store): void
  subscribe(listener: () => void): () => void
}

function createStoreApi(initial: Store): StoreApi {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    publish(next) {
      if (Object.is(snapshot, next)) return
      snapshot = next
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

interface GraphBridge {
  cancelSourceProbe: () => void
  resetSourceSelection: (file: string) => void
  renameSourceFile: (oldName: string, newName: string) => void
  deleteSourceFile: (name: string, fallbackFile: string) => void
  clearForWorkspaceReset: () => void
  afterSynthesis: () => void
}

export function StoreProvider({
  children,
  initialWorkspace,
}: {
  children: ReactNode
  initialWorkspace?: WorkspaceState | null
}) {
  const initial = initialWorkspace ?? defaultWorkspace()

  // Slice-owned state is mirrored through these narrow refs so event handlers
  // always observe the latest inputs without creating a second shared store.
  const filesRef = useRef(initial.files)
  const topRef = useRef(initial.top)
  const modeRef = useRef(initial.mode)
  const extraArgsRef = useRef(initial.extraArgs)
  const synthToolRef = useRef<SynthTool>('yosys')
  const vivadoStatusRef = useRef<VivadoBridgeStatus | null>(null)
  const vivadoTargetRef = useRef(initial.vivadoTarget)
  const vivadoExtraArgsRef = useRef(initial.vivadoExtraArgs)
  const graphBridgeRef = useRef<GraphBridge | null>(null)
  const clearVivadoConnectionRef = useRef<
    ((options: { markChanged?: boolean }) => void) | null
  >(null)

  const afterSynthesis = useCallback(
    () => graphBridgeRef.current!.afterSynthesis(),
    [],
  )
  const clearVivadoConnection = useCallback(
    (options: { markChanged?: boolean }) =>
      clearVivadoConnectionRef.current!(options),
    [],
  )

  const synthesisRefs = useMemo(
    () => ({
      files: filesRef,
      top: topRef,
      mode: modeRef,
      synthTool: synthToolRef,
      extraArgs: extraArgsRef,
      vivadoStatus: vivadoStatusRef,
      vivadoTarget: vivadoTargetRef,
      vivadoExtraArgs: vivadoExtraArgsRef,
    }),
    [],
  )

  const synthesis = useSynthesisSlice({
    refs: synthesisRefs,
    afterSynthesis,
    clearVivadoConnection,
  })
  const preferences = usePreferencesSlice()
  const vivadoRefs = useMemo(
    () => ({
      synthTool: synthToolRef,
      status: vivadoStatusRef,
      target: vivadoTargetRef,
      extraArgs: vivadoExtraArgsRef,
    }),
    [],
  )
  const vivado = useVivadoSlice({
    initialSynthTool: initial.synthTool,
    initialTarget: initial.vivadoTarget,
    initialExtraArgs: initial.vivadoExtraArgs,
    refs: vivadoRefs,
    markInputChanged: synthesis.markInputChanged,
    setError: synthesis.setError,
  })
  clearVivadoConnectionRef.current = vivado.clearVivadoConnection

  const workspaceGraphActions = useMemo(
    () => ({
      cancelSourceProbe: () => graphBridgeRef.current!.cancelSourceProbe(),
      resetSourceSelection: (file: string) =>
        graphBridgeRef.current!.resetSourceSelection(file),
      renameSourceFile: (oldName: string, newName: string) =>
        graphBridgeRef.current!.renameSourceFile(oldName, newName),
      deleteSourceFile: (name: string, fallbackFile: string) =>
        graphBridgeRef.current!.deleteSourceFile(name, fallbackFile),
      clearForWorkspaceReset: () =>
        graphBridgeRef.current!.clearForWorkspaceReset(),
    }),
    [],
  )
  const workspaceRefs = useMemo(
    () => ({
      files: filesRef,
      top: topRef,
      mode: modeRef,
      extraArgs: extraArgsRef,
      vivadoTarget: vivadoTargetRef,
      vivadoExtraArgs: vivadoExtraArgsRef,
    }),
    [],
  )
  const workspace = useWorkspaceSlice({
    initial,
    refs: workspaceRefs,
    rememberedSynthTool: vivado.rememberedSynthTool,
    markInputChanged: synthesis.markInputChanged,
    graph: workspaceGraphActions,
    resetAnalysis: synthesis.resetAnalysis,
    setExampleSelection: preferences.setExampleSelection,
  })
  const graph = useGraphRequestSlice({
    initialActiveFileName: initial.activeFileName,
    filesRef,
    designRef: synthesis.designRef,
    analysisStateRef: synthesis.analysisStateRef,
    setActiveFileNameState: workspace.setActiveFileNameState,
  })
  graphBridgeRef.current = {
    cancelSourceProbe: graph.cancelSourceProbe,
    resetSourceSelection: graph.resetSourceSelection,
    renameSourceFile: graph.renameSourceFile,
    deleteSourceFile: graph.deleteSourceFile,
    clearForWorkspaceReset: graph.clearForWorkspaceReset,
    afterSynthesis: graph.afterSynthesis,
  }

  // Preserve the provider's original effect order across the extracted hooks.
  usePreferencesPersistence(preferences.synthesisSettings)
  useWorkspacePersistence({
    workspaceSaveTimerRef: workspace.workspaceSaveTimerRef,
    workspaceSnapshotRef: workspace.workspaceSnapshotRef,
    cancelScheduledWorkspaceSave: workspace.cancelScheduledWorkspaceSave,
    dependencies: [
      workspace.activeFileName,
      workspace.cancelScheduledWorkspaceSave,
      workspace.extraArgs,
      workspace.files,
      workspace.mode,
      vivado.rememberedSynthTool,
      workspace.top,
      vivado.vivadoExtraArgs,
      vivado.vivadoTarget,
    ],
  })
  useGraphRequestCleanup(graph.cancelSourceProbe)
  useAnalysisStateEffect({
    analysisState: synthesis.analysisState,
    selectSchematicNodes: graph.selectSchematicNodes,
    setError: synthesis.setError,
  })
  useVivadoRestore({
    initialSynthTool: initial.synthTool,
    adoptVivadoStatus: vivado.adoptVivadoStatus,
    setSynthTool: vivado.setSynthTool,
    setRememberedSynthTool: vivado.setRememberedSynthTool,
  })
  useSynthesisEffects({
    autoSynthesize: preferences.synthesisSettings.autoSynthesize,
    delayMs: preferences.synthesisSettings.delayMs,
    synthTool: vivado.synthTool,
    inputRevision: synthesis.inputRevision,
    inputRevisionRef: synthesis.inputRevisionRef,
    requestedRevisionRef: synthesis.requestedRevisionRef,
    requestSynthesis: synthesis.requestSynthesis,
    queue: synthesis.queue,
  })

  const value = useMemo<Store>(
    () => ({
      files: workspace.files,
      activeFileName: workspace.activeFileName,
      docRevision: workspace.docRevision,
      top: workspace.top,
      synthTool: vivado.synthTool,
      mode: workspace.mode,
      extraArgs: workspace.extraArgs,
      vivadoStatus: vivado.vivadoStatus,
      vivadoTarget: vivado.vivadoTarget,
      vivadoExtraArgs: vivado.vivadoExtraArgs,
      examples: workspace.examples,
      setActiveFileName: graph.setActiveFileName,
      updateFileContent: workspace.updateFileContent,
      addFile: workspace.addFile,
      importFiles: workspace.importFiles,
      renameFile: workspace.renameFile,
      deleteFile: workspace.deleteFile,
      resetWorkspace: workspace.resetWorkspace,
      setTop: workspace.setTop,
      setSynthTool: vivado.setSynthTool,
      setMode: workspace.setMode,
      setExtraArgs: workspace.setExtraArgs,
      setVivadoTarget: vivado.setVivadoTarget,
      setVivadoExtraArgs: vivado.setVivadoExtraArgs,
      connectVivado: vivado.connectVivado,
      disconnectVivado: vivado.disconnectVivado,
      loadExample: workspace.loadExample,
      exampleSelection: preferences.exampleSelection,
      setExampleSelection: preferences.setExampleSelection,
      confirmWorkspaceReset: preferences.confirmWorkspaceReset,
      setConfirmWorkspaceReset: preferences.setConfirmWorkspaceReset,
      editorKeymap: preferences.editorKeymap,
      setEditorKeymap: preferences.setEditorKeymap,
      editorLineNumbers: preferences.editorLineNumbers,
      setEditorLineNumbers: preferences.setEditorLineNumbers,
      autoSynthesize: preferences.synthesisSettings.autoSynthesize,
      setAutoSynthesize: preferences.setAutoSynthesize,
      autoSynthesisDelayMs: preferences.synthesisSettings.delayMs,
      setAutoSynthesisDelayMs: preferences.setAutoSynthesisDelayMs,
      synthesizing: synthesis.synthesizing,
      synthesize: synthesis.requestSynthesis,
      design: synthesis.design,
      designRevision: synthesis.designRevision,
      analysisState: synthesis.analysisState,
      error: synthesis.error,
      activeTab: graph.activeTab,
      setActiveTab: graph.setActiveTab,
      coneReq: graph.coneReq,
      graphOptions: graph.graphOptions,
      setGraphOptions: graph.setGraphOptions,
      openCone: graph.openCone,
      openControlCone: graph.openControlCone,
      showPathInGraph: graph.showPathInGraph,
      clearGraphSelection: graph.clearGraphSelection,
      registerGraphProbeReset: graph.registerGraphProbeReset,
      editorHighlight: graph.editorHighlight,
      highlightSources: graph.highlightSources,
      selectSchematicNodes: graph.selectSchematicNodes,
      selectSchematicNets: graph.selectSchematicNets,
      sourceSelection: graph.sourceSelection,
      setSourceSelection: graph.setSourceSelection,
    }),
    [
      workspace.files,
      workspace.activeFileName,
      workspace.docRevision,
      workspace.top,
      vivado.synthTool,
      workspace.mode,
      workspace.extraArgs,
      vivado.vivadoStatus,
      vivado.vivadoTarget,
      vivado.vivadoExtraArgs,
      workspace.examples,
      graph.setActiveFileName,
      workspace.updateFileContent,
      workspace.addFile,
      workspace.importFiles,
      workspace.renameFile,
      workspace.deleteFile,
      workspace.resetWorkspace,
      workspace.setTop,
      vivado.setSynthTool,
      workspace.setMode,
      workspace.setExtraArgs,
      vivado.setVivadoTarget,
      vivado.setVivadoExtraArgs,
      vivado.connectVivado,
      vivado.disconnectVivado,
      workspace.loadExample,
      preferences.exampleSelection,
      preferences.setExampleSelection,
      preferences.confirmWorkspaceReset,
      preferences.setConfirmWorkspaceReset,
      preferences.editorKeymap,
      preferences.setEditorKeymap,
      preferences.editorLineNumbers,
      preferences.setEditorLineNumbers,
      preferences.synthesisSettings,
      preferences.setAutoSynthesize,
      preferences.setAutoSynthesisDelayMs,
      synthesis.synthesizing,
      synthesis.requestSynthesis,
      synthesis.design,
      synthesis.designRevision,
      synthesis.analysisState,
      synthesis.error,
      graph.activeTab,
      graph.setActiveTab,
      graph.coneReq,
      graph.graphOptions,
      graph.setGraphOptions,
      graph.openCone,
      graph.openControlCone,
      graph.showPathInGraph,
      graph.clearGraphSelection,
      graph.registerGraphProbeReset,
      graph.editorHighlight,
      graph.highlightSources,
      graph.selectSchematicNodes,
      graph.selectSchematicNets,
      graph.sourceSelection,
      graph.setSourceSelection,
    ],
  )

  const apiRef = useRef<StoreApi | null>(null)
  if (!apiRef.current) apiRef.current = createStoreApi(value)
  const storeApi = apiRef.current
  useLayoutEffect(() => storeApi.publish(value), [storeApi, value])

  return <StoreContext.Provider value={storeApi}>{children}</StoreContext.Provider>
}
