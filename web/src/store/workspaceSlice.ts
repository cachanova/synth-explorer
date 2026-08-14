import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { DEFAULT_FILE } from '../data/defaultWorkspace'
import type { ExampleSelection } from '../lib/exampleSelection'
import { NO_EXAMPLE_SELECTION } from '../lib/exampleSelection'
import * as designClient from '../lib/designClient'
import { mergeComputerFiles } from '../lib/launcher/computerFiles'
import {
  flagsForModeTransition,
  type ModeFlagMemory,
} from '../lib/synthesis/flagRegistry'
import {
  markWorkspaceResetPending,
  saveWorkspace,
  type WorkspaceState,
} from '../lib/workspaceStorage'
import type { DesignFile, Example, ExampleVariant, Mode, SynthTool } from '../types'

interface WorkspaceRefs {
  files: RefObject<DesignFile[]>
  top: RefObject<string>
  mode: RefObject<Mode>
  extraArgs: RefObject<string>
  vivadoTarget: RefObject<string>
  vivadoExtraArgs: RefObject<string>
}

interface WorkspaceGraphActions {
  cancelSourceProbe: () => void
  resetSourceSelection: (file: string) => void
  renameSourceFile: (oldName: string, newName: string) => void
  deleteSourceFile: (name: string, fallbackFile: string) => void
  clearForWorkspaceReset: () => void
}

export function useWorkspaceSlice({
  initial,
  refs,
  rememberedSynthTool,
  markInputChanged,
  graph,
  resetAnalysis,
  setExampleSelection,
}: {
  initial: WorkspaceState
  refs: WorkspaceRefs
  rememberedSynthTool: SynthTool
  markInputChanged: () => void
  graph: WorkspaceGraphActions
  resetAnalysis: () => void
  setExampleSelection: (selection: ExampleSelection) => void
}) {
  const [files, setFiles] = useState<DesignFile[]>(initial.files)
  const [activeFileName, setActiveFileNameState] = useState(initial.activeFileName)
  const [docRevision, setDocRevision] = useState(0)
  const [top, setTopState] = useState(initial.top)
  const [mode, setModeState] = useState<Mode>(initial.mode)
  const [extraArgs, setExtraArgsState] = useState(initial.extraArgs)
  const [examples, setExamples] = useState<Example[]>([])

  refs.files.current = files
  refs.top.current = top
  refs.mode.current = mode
  refs.extraArgs.current = extraArgs

  // Historical flags for inactive modes stay session-local. The active mode
  // and its exact flags are part of the persisted workspace.
  const modeFlagMemoryRef = useRef<ModeFlagMemory>({})
  const workspaceSaveTimerRef = useRef<number | null>(null)
  const workspaceSnapshotRef = useRef<WorkspaceState>(initial)
  workspaceSnapshotRef.current = {
    files,
    activeFileName,
    top,
    mode,
    extraArgs,
    vivadoExtraArgs: refs.vivadoExtraArgs.current,
    synthTool: rememberedSynthTool,
    vivadoTarget: refs.vivadoTarget.current,
  }

  const cancelScheduledWorkspaceSave = useCallback(() => {
    if (workspaceSaveTimerRef.current == null) return
    window.clearTimeout(workspaceSaveTimerRef.current)
    workspaceSaveTimerRef.current = null
  }, [])

  // Load examples once.
  const loadedExamples = useRef(false)
  if (!loadedExamples.current) {
    loadedExamples.current = true
    designClient
      .getExamples()
      .then((response) => setExamples(response.examples))
      .catch(() => {
        /* bundled examples are optional; keep the editor usable if they fail to load */
      })
  }

  const updateFileContent = useCallback(
    (name: string, content: string) => {
      const current = refs.files.current
      const existing = current.find((file) => file.name === name)
      if (!existing || existing.content === content) return
      const next = current.map((file) =>
        file.name === name ? { ...file, content } : file,
      )
      refs.files.current = next
      markInputChanged()
      setFiles(next)
    },
    [markInputChanged, refs.files],
  )

  const addFile = useCallback(() => {
    graph.cancelSourceProbe()
    const current = refs.files.current
    const currentActiveName = workspaceSnapshotRef.current.activeFileName
    const extension =
      currentActiveName.endsWith('.vhd') || currentActiveName.endsWith('.vhdl')
        ? '.vhdl'
        : '.sv'
    let index = current.length
    let name = `file${index}${extension}`
    const names = new Set(current.map((file) => file.name))
    while (names.has(name)) {
      index += 1
      name = `file${index}${extension}`
    }
    const next = [...current, { name, content: '' }]
    refs.files.current = next
    markInputChanged()
    setFiles(next)
    setActiveFileNameState(name)
    graph.resetSourceSelection(name)
  }, [graph, markInputChanged, refs.files])

  const importFiles = useCallback(
    (imported: DesignFile[]) => {
      if (imported.length === 0) return
      graph.cancelSourceProbe()
      const current = refs.files.current
      const next = mergeComputerFiles(current, imported)
      const contentChanged =
        next.length !== current.length ||
        next.some(
          (file, index) =>
            file.name !== current[index]?.name ||
            file.content !== current[index]?.content,
        )
      refs.files.current = next
      if (contentChanged) {
        markInputChanged()
        setFiles(next)
      }
      setDocRevision((revision) => revision + 1)
      const active = imported[0].name
      setActiveFileNameState(active)
      graph.resetSourceSelection(active)
    },
    [graph, markInputChanged, refs.files],
  )

  const renameFile = useCallback(
    (oldName: string, newName: string) => {
      graph.cancelSourceProbe()
      const clean = newName.trim()
      if (!clean || !/^[A-Za-z0-9._-]+$/.test(clean)) return
      const current = refs.files.current
      if (
        clean === oldName ||
        !current.some((file) => file.name === oldName) ||
        current.some((file) => file.name === clean && file.name !== oldName)
      ) {
        return
      }
      const next = current.map((file) =>
        file.name === oldName ? { ...file, name: clean } : file,
      )
      refs.files.current = next
      markInputChanged()
      setFiles(next)
      setActiveFileNameState((currentName) =>
        currentName === oldName ? clean : currentName,
      )
      graph.renameSourceFile(oldName, clean)
    },
    [graph, markInputChanged, refs.files],
  )

  const deleteFile = useCallback(
    (name: string) => {
      graph.cancelSourceProbe()
      const current = refs.files.current
      if (current.length <= 1 || !current.some((file) => file.name === name)) return
      const next = current.filter((file) => file.name !== name)
      refs.files.current = next
      markInputChanged()
      setFiles(next)
      setActiveFileNameState((currentName) =>
        currentName === name ? next[0].name : currentName,
      )
      graph.deleteSourceFile(name, next[0].name)
    },
    [graph, markInputChanged, refs.files],
  )

  const resetWorkspace = useCallback(() => {
    graph.cancelSourceProbe()
    cancelScheduledWorkspaceSave()
    const next: WorkspaceState = {
      files: [{ ...DEFAULT_FILE }],
      activeFileName: DEFAULT_FILE.name,
      top: '',
      mode: refs.mode.current,
      extraArgs: refs.extraArgs.current,
      vivadoExtraArgs: refs.vivadoExtraArgs.current,
      synthTool: rememberedSynthTool,
      vivadoTarget: refs.vivadoTarget.current,
    }
    refs.files.current = next.files
    refs.top.current = next.top
    workspaceSnapshotRef.current = next
    // The buffer is back to the default file, so the dropdowns must stop
    // naming an example. Leaving the name also blocks re-picking it.
    setExampleSelection(NO_EXAMPLE_SELECTION)
    markWorkspaceResetPending(next)
    markInputChanged()
    setFiles(next.files)
    setActiveFileNameState(next.activeFileName)
    setDocRevision((revision) => revision + 1)
    setTopState(next.top)
    graph.resetSourceSelection(DEFAULT_FILE.name)
    resetAnalysis()
    graph.clearForWorkspaceReset()
    void saveWorkspace(next, true)
  }, [
    cancelScheduledWorkspaceSave,
    graph,
    markInputChanged,
    refs,
    rememberedSynthTool,
    resetAnalysis,
    setExampleSelection,
  ])

  const setTop = useCallback(
    (value: string) => {
      if (refs.top.current === value) return
      refs.top.current = value
      markInputChanged()
      setTopState(value)
    },
    [markInputChanged, refs.top],
  )

  const setMode = useCallback(
    (value: Mode) => {
      if (refs.mode.current === value) return
      const transition = flagsForModeTransition(
        refs.extraArgs.current,
        refs.mode.current,
        value,
        modeFlagMemoryRef.current,
      )
      modeFlagMemoryRef.current = transition.memory
      refs.mode.current = value
      const nextFlags = transition.flags
      if (nextFlags !== refs.extraArgs.current) {
        refs.extraArgs.current = nextFlags
        setExtraArgsState(nextFlags)
      }
      markInputChanged()
      setModeState(value)
    },
    [markInputChanged, refs.extraArgs, refs.mode],
  )

  const setExtraArgs = useCallback(
    (value: string) => {
      if (refs.extraArgs.current === value) return
      refs.extraArgs.current = value
      markInputChanged()
      setExtraArgsState(value)
    },
    [markInputChanged, refs.extraArgs],
  )

  const loadExample = useCallback(
    (variant: ExampleVariant) => {
      graph.cancelSourceProbe()
      const nextFiles = variant.files.length ? variant.files : [DEFAULT_FILE]
      const nextTop = variant.top ?? ''
      refs.files.current = nextFiles
      refs.top.current = nextTop
      markInputChanged()
      setFiles(nextFiles)
      // Reloading the already-active example changes content without changing
      // the active file name, so the editor needs an explicit reset signal.
      setDocRevision((revision) => revision + 1)
      const firstFile = variant.files[0]?.name ?? DEFAULT_FILE.name
      setActiveFileNameState(firstFile)
      graph.resetSourceSelection(firstFile)
      setTopState(nextTop)
    },
    [graph, markInputChanged, refs.files, refs.top],
  )

  return {
    files,
    activeFileName,
    setActiveFileNameState,
    docRevision,
    top,
    mode,
    extraArgs,
    examples,
    updateFileContent,
    addFile,
    importFiles,
    renameFile,
    deleteFile,
    resetWorkspace,
    setTop,
    setMode,
    setExtraArgs,
    loadExample,
    workspaceSaveTimerRef,
    workspaceSnapshotRef,
    cancelScheduledWorkspaceSave,
  }
}

export function useWorkspacePersistence({
  workspaceSaveTimerRef,
  workspaceSnapshotRef,
  cancelScheduledWorkspaceSave,
  activeFileName,
  extraArgs,
  files,
  mode,
  rememberedSynthTool,
  top,
  vivadoExtraArgs,
  vivadoTarget,
}: {
  workspaceSaveTimerRef: RefObject<number | null>
  workspaceSnapshotRef: RefObject<WorkspaceState>
  cancelScheduledWorkspaceSave: () => void
  activeFileName: string
  extraArgs: string
  files: DesignFile[]
  mode: Mode
  rememberedSynthTool: SynthTool
  top: string
  vivadoExtraArgs: string
  vivadoTarget: string
}) {
  useEffect(() => {
    cancelScheduledWorkspaceSave()
    workspaceSaveTimerRef.current = window.setTimeout(() => {
      workspaceSaveTimerRef.current = null
      void saveWorkspace(workspaceSnapshotRef.current)
    }, 250)
    return cancelScheduledWorkspaceSave
  }, [
    activeFileName,
    cancelScheduledWorkspaceSave,
    extraArgs,
    files,
    mode,
    rememberedSynthTool,
    top,
    vivadoExtraArgs,
    vivadoTarget,
    workspaceSaveTimerRef,
    workspaceSnapshotRef,
  ])

  useEffect(() => {
    const flush = () => {
      cancelScheduledWorkspaceSave()
      void saveWorkspace(workspaceSnapshotRef.current)
    }
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', flushWhenHidden)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', flushWhenHidden)
    }
  }, [cancelScheduledWorkspaceSave, workspaceSnapshotRef])
}
