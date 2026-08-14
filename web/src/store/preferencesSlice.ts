import { useCallback, useEffect, useState } from 'react'
import {
  loadExampleSelection,
  saveExampleSelection,
  type ExampleSelection,
} from '../lib/exampleSelection'
import {
  clampAutoSynthesisDelay,
  loadSynthesisSettings,
  saveSynthesisSettings,
} from '../lib/synthesis/synthesisSettings'
import {
  loadEditorKeymapPreference,
  loadEditorLineNumbersPreference,
  loadResetConfirmationPreference,
  saveEditorKeymapPreference,
  saveEditorLineNumbersPreference,
  saveResetConfirmationPreference,
  type EditorKeymap,
  type EditorLineNumbers,
} from '../lib/workspaceStorage'

export function usePreferencesSlice() {
  const [confirmWorkspaceReset, setConfirmWorkspaceResetState] = useState(
    loadResetConfirmationPreference,
  )
  const [editorKeymap, setEditorKeymapState] = useState(
    loadEditorKeymapPreference,
  )
  const [synthesisSettings, setSynthesisSettings] = useState(
    loadSynthesisSettings,
  )
  const [editorLineNumbers, setEditorLineNumbersState] = useState(
    loadEditorLineNumbersPreference,
  )
  // Which example the toolbar dropdowns show. It is not a synthesis input:
  // the persisted workspace already restores the buffer, edits included.
  const [exampleSelection, setExampleSelectionState] = useState<ExampleSelection>(
    loadExampleSelection,
  )

  const setAutoSynthesize = useCallback((enabled: boolean) => {
    setSynthesisSettings((current) =>
      current.autoSynthesize === enabled
        ? current
        : { ...current, autoSynthesize: enabled },
    )
  }, [])

  const setAutoSynthesisDelayMs = useCallback((delayMs: number) => {
    const clamped = clampAutoSynthesisDelay(delayMs)
    setSynthesisSettings((current) =>
      current.delayMs === clamped ? current : { ...current, delayMs: clamped },
    )
  }, [])

  const setExampleSelection = useCallback((selection: ExampleSelection) => {
    saveExampleSelection(selection)
    setExampleSelectionState(selection)
  }, [])

  const setConfirmWorkspaceReset = useCallback((enabled: boolean) => {
    setConfirmWorkspaceResetState(enabled)
    saveResetConfirmationPreference(enabled)
  }, [])

  const setEditorKeymap = useCallback((keymap: EditorKeymap) => {
    setEditorKeymapState(keymap)
    saveEditorKeymapPreference(keymap)
  }, [])

  const setEditorLineNumbers = useCallback((mode: EditorLineNumbers) => {
    setEditorLineNumbersState(mode)
    saveEditorLineNumbersPreference(mode)
  }, [])

  return {
    confirmWorkspaceReset,
    setConfirmWorkspaceReset,
    editorKeymap,
    setEditorKeymap,
    synthesisSettings,
    setAutoSynthesize,
    setAutoSynthesisDelayMs,
    editorLineNumbers,
    setEditorLineNumbers,
    exampleSelection,
    setExampleSelection,
  }
}

export function usePreferencesPersistence(
  synthesisSettings: ReturnType<typeof loadSynthesisSettings>,
) {
  useEffect(() => saveSynthesisSettings(synthesisSettings), [synthesisSettings])
}
