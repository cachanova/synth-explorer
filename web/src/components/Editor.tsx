import { useCallback, useEffect, useRef } from 'react'
import {
  Annotation,
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type DecorationSet,
} from '@codemirror/view'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  insertTab,
} from '@codemirror/commands'
import {
  bracketMatching,
  HighlightStyle,
  StreamLanguage,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { selectedSourceRange } from '../lib/editorSourceSelection'
import {
  closeBrackets,
  closeBracketsKeymap,
} from '@codemirror/autocomplete'
import {
  highlightSelectionMatches,
  searchKeymap,
} from '@codemirror/search'
import { verilog } from '@codemirror/legacy-modes/mode/verilog'
import { vhdl } from '@codemirror/legacy-modes/mode/vhdl'
import { tags } from '@lezer/highlight'
import type { EditorHighlight } from '../store'
import { useTheme } from '../lib/themeContext'
import { shallowEqual, useStore } from '../useStore'

// Keep editor chrome and syntax on the same CSS tokens as the selected app
// palette. CSS variables update in place when the palette changes; CodeMirror's
// dark facet only needs reconfiguring when the resolved appearance changes.
const appHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--text-faint)', fontStyle: 'italic' },
  { tag: [tags.keyword, tags.bool, tags.null], color: 'var(--seq)' },
  {
    tag: [
      tags.definition(tags.variableName),
      tags.typeName,
      tags.className,
      tags.labelName,
    ],
    color: 'var(--blue)',
  },
  { tag: [tags.string, tags.character], color: 'var(--green)' },
  { tag: [tags.number, tags.unit], color: 'var(--amber)' },
  {
    tag: [tags.operator, tags.meta, tags.macroName],
    color: 'var(--accent)',
  },
  { tag: tags.punctuation, color: 'var(--text-dim)' },
  { tag: tags.invalid, color: 'var(--red)', textDecoration: 'underline' },
])

function createEditorTheme(dark: boolean): Extension {
  return [
    EditorView.theme(
      {
        '&': { color: 'var(--text)', backgroundColor: 'var(--bg)' },
        '.cm-content': { caretColor: 'var(--accent)' },
        '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
          { backgroundColor: 'color-mix(in srgb, var(--accent) 24%, transparent)' },
        '.cm-panels': { backgroundColor: 'var(--bg-1)', color: 'var(--text)' },
        '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
        '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
        '.cm-searchMatch': {
          backgroundColor: 'color-mix(in srgb, var(--amber) 22%, transparent)',
          outline: '1px solid color-mix(in srgb, var(--amber) 55%, transparent)',
        },
        '.cm-searchMatch.cm-searchMatch-selected': {
          backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent)',
        },
        '.cm-selectionMatch': {
          backgroundColor: 'color-mix(in srgb, var(--accent) 14%, transparent)',
        },
        '.cm-matchingBracket': {
          backgroundColor: 'color-mix(in srgb, var(--blue) 22%, transparent)',
          outline: '1px solid color-mix(in srgb, var(--blue) 55%, transparent)',
        },
        '.cm-gutters': {
          backgroundColor: 'var(--bg)',
          color: 'var(--text-faint)',
          borderRight: 'none',
        },
        '.cm-activeLine, .cm-activeLineGutter': {
          backgroundColor: 'color-mix(in srgb, var(--text) 5%, transparent)',
        },
        '.cm-foldPlaceholder': {
          backgroundColor: 'var(--bg-2)',
          border: '1px solid var(--border-strong)',
          color: 'var(--text-dim)',
        },
        '.cm-tooltip': {
          backgroundColor: 'var(--bg-1)',
          border: '1px solid var(--border-strong)',
          color: 'var(--text)',
        },
        '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
          backgroundColor: 'var(--bg-3)',
          color: 'var(--text)',
        },
      },
      { dark },
    ),
    syntaxHighlighting(appHighlightStyle),
  ]
}

const editorThemes: Record<'light' | 'dark', Extension> = {
  light: createEditorTheme(false),
  dark: createEditorTheme(true),
}
let vimKeysConfigured = false

function sourceLanguageExtension(name: string): Extension {
  return StreamLanguage.define(name.endsWith('.vhd') || name.endsWith('.vhdl') ? vhdl : verilog)
}

function lineNumberExtension(relative: boolean, activeLine = 1): Extension {
  return relative
    ? lineNumbers({
        formatNumber(lineNumber) {
          return lineNumber === activeLine
            ? String(lineNumber)
            : String(Math.abs(lineNumber - activeLine))
        },
      })
    : lineNumbers()
}

// --- src highlight state ---
const setHighlight = StateEffect.define<
  { from: number; to?: number; primary: boolean }[] | null
>()
const programmaticUpdate = Annotation.define<boolean>()
const secondaryLine = Decoration.line({
  attributes: {
    class: 'cm-src-hl-secondary',
    style: 'background-color: color-mix(in srgb, var(--accent) 10%, transparent)',
  },
})
const primaryLine = Decoration.line({
  attributes: { class: 'cm-src-hl' },
})
const primaryRange = Decoration.mark({ class: 'cm-src-range-hl' })
const secondaryRange = Decoration.mark({ class: 'cm-src-range-hl-secondary' })

const highlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(deco, tr) {
    let next = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(setHighlight)) {
        if (e.value == null) next = Decoration.none
        else {
          next = Decoration.set(
            e.value.map(({ from, to, primary }) =>
              to == null
                ? (primary ? primaryLine : secondaryLine).range(from)
                : (primary ? primaryRange : secondaryRange).range(from, to),
            ),
            true,
          )
        }
      }
    }
    return next
  },
  provide: (f) => EditorView.decorations.from(f),
})

function applyHighlight(view: EditorView, hl: EditorHighlight, activeFile: string) {
  const doc = view.state.doc
  const primarySpan = hl.spans[hl.primary]
  const linePriority = new Map<number, boolean>()
  hl.spans.forEach((span, index) => {
    if (span.file !== activeFile) return
    const start = Math.min(Math.max(span.startLine, 1), doc.lines)
    const end = Math.min(Math.max(span.endLine, start), doc.lines)
    for (let line = start; line <= end; line += 1) {
      const primary = index === hl.primary
      linePriority.set(line, primary || linePriority.get(line) === true)
    }
  })
  const decorations: { from: number; to?: number; primary: boolean }[] = [
    ...linePriority.entries(),
  ]
    .sort(([a], [b]) => a - b)
    .map(([line, primary]) => ({ from: doc.line(line).from, primary }))

  hl.spans.forEach((span, index) => {
    if (span.file !== activeFile || !span.exact) return
    const startLine = doc.line(Math.min(Math.max(span.startLine, 1), doc.lines))
    const endLine = doc.line(Math.min(Math.max(span.endLine, startLine.number), doc.lines))
    const from = startLine.from + Math.min(Math.max(span.startCol - 1, 0), startLine.length)
    const to = endLine.from + Math.min(Math.max(span.endCol, 1), endLine.length)
    if (to > from) decorations.push({ from, to, primary: index === hl.primary })
  })
  decorations.sort(
    (left, right) =>
      left.from - right.from || Number(left.to != null) - Number(right.to != null),
  )

  const primaryLineNumber =
    primarySpan?.file === activeFile
      ? Math.min(Math.max(primarySpan.startLine, 1), doc.lines)
      : decorations.length > 0
        ? doc.lineAt(decorations[0].from).number
        : 1
  const primaryLine = doc.line(primaryLineNumber)
  const primaryPosition =
    primarySpan?.file === activeFile
      ? primaryLine.from +
        Math.min(Math.max(primarySpan.startCol - 1, 0), primaryLine.length)
      : primaryLine.from
  view.dispatch({
    selection: { anchor: primaryPosition },
    effects: [
      setHighlight.of(decorations),
      EditorView.scrollIntoView(primaryPosition, { y: 'center' }),
    ],
    annotations: programmaticUpdate.of(true),
  })
}

export function Editor() {
  const store = useStore(
    ({
      files,
      activeFileName,
      docRevision,
      editorHighlight,
      error,
      updateFileContent,
      setSourceSelection,
      clearGraphSelection,
      editorKeymap,
      setEditorKeymap,
      editorLineNumbers,
    }) => ({
      files,
      activeFileName,
      docRevision,
      editorHighlight,
      error,
      updateFileContent,
      setSourceSelection,
      clearGraphSelection,
      editorKeymap,
      setEditorKeymap,
      editorLineNumbers,
    }),
    shallowEqual,
  )
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)

  const { resolvedMode } = useTheme()

  // stable refs so the editor is created once
  const storeRef = useRef(store)
  storeRef.current = store
  const currentFileRef = useRef(store.activeFileName)
  currentFileRef.current = store.activeFileName
  // theme lives in a compartment so it can be swapped without rebuilding the view
  const themeCompartment = useRef(new Compartment())
  const languageCompartment = useRef(new Compartment())
  const lineNumberCompartment = useRef(new Compartment())
  const resolvedModeRef = useRef(resolvedMode)
  resolvedModeRef.current = resolvedMode
  const appliedModeRef = useRef(resolvedMode)
  const editorKeymapRef = useRef(store.editorKeymap)
  editorKeymapRef.current = store.editorKeymap
  const vimCompartment = useRef(new Compartment())
  const vimLoadRef = useRef(0)
  const vimTypingRef = useRef(false)
  const editorHoveredRef = useRef(false)
  const browserFocusedRef = useRef(true)
  const appliedLineNumbersRef = useRef('regular')
  const diagnosticsLoadRef = useRef(0)
  const setDiagnosticsRef = useRef<
    typeof import('@codemirror/lint')['setDiagnostics'] | null
  >(null)

  const refreshLineNumbers = useCallback((view: EditorView) => {
    const preference = storeRef.current.editorLineNumbers
    const relative =
      preference === 'relative' ||
      (preference === 'hybrid' &&
        editorKeymapRef.current === 'vim' &&
        !vimTypingRef.current &&
        editorHoveredRef.current &&
        browserFocusedRef.current)
    const activeLine = view.state.doc.lineAt(view.state.selection.main.head).number
    const signature = relative ? `relative:${activeLine}` : 'regular'
    if (appliedLineNumbersRef.current === signature) return
    appliedLineNumbersRef.current = signature
    view.dispatch({
      effects: lineNumberCompartment.current.reconfigure(
        lineNumberExtension(relative, activeLine),
      ),
    })
  }, [])

  const queueLineNumberRefresh = useCallback(
    (view: EditorView) => {
      queueMicrotask(() => {
        if (viewRef.current === view) refreshLineNumbers(view)
      })
    },
    [refreshLineNumbers],
  )

  // create the view once
  useEffect(() => {
    if (!hostRef.current) return
    const initial =
      storeRef.current.files.find((f) => f.name === storeRef.current.activeFileName)
        ?.content ?? ''

    const updateListener = EditorView.updateListener.of((u) => {
      const isProgrammatic = u.transactions.some((tr) =>
        tr.annotation(programmaticUpdate),
      )
      if (!isProgrammatic) {
        if (u.docChanged) {
          const text = u.state.doc.toString()
          storeRef.current.updateFileContent(currentFileRef.current, text)
        }
        if (u.selectionSet || u.docChanged) {
          const {
            startLine,
            startColumn,
            endLine,
            endColumn,
            fallbackStartColumn,
            fallbackEndColumn,
          } = selectedSourceRange(u.state)
          storeRef.current.setSourceSelection(
            currentFileRef.current,
            startLine,
            endLine,
            startColumn,
            endColumn,
            fallbackStartColumn,
            fallbackEndColumn,
          )
        }
      }
      if (u.selectionSet || u.docChanged) {
        queueLineNumberRefresh(u.view)
      }
    })

    const editorKeymap = keymap.of([
      {
        key: 'Escape',
        preventDefault: true,
        run: () => true,
      },
    ])
    const clearGraphSelectionOnEscape = EditorView.domEventHandlers({
      keydown(event) {
        if (event.key === 'Escape') storeRef.current.clearGraphSelection()
        return false
      },
    })
    const inVimCommandMode = () =>
      editorKeymapRef.current === 'vim' && !vimTypingRef.current
    const initialRelative = storeRef.current.editorLineNumbers === 'relative'
    appliedLineNumbersRef.current = initialRelative ? 'relative:1' : 'regular'

    const extensions: Extension[] = [
      clearGraphSelectionOnEscape,
      vimCompartment.current.of([]),
      lineNumberCompartment.current.of(lineNumberExtension(initialRelative)),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      drawSelection(),
      history(),
      languageCompartment.current.of(sourceLanguageExtension(currentFileRef.current)),
      indentOnInput(),
      closeBrackets(),
      bracketMatching(),
      highlightSelectionMatches(),
      themeCompartment.current.of(editorThemes[resolvedModeRef.current]),
      highlightField,
      keymap.of([
        {
          key: 'Tab',
          run: (view) => (inVimCommandMode() ? true : insertTab(view)),
          shift: (view) => (inVimCommandMode() ? true : indentLess(view)),
        },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
      ]),
      editorKeymap,
      updateListener,
      EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto' } }),
    ]

    const view = new EditorView({
      state: EditorState.create({ doc: initial, extensions }),
      parent: hostRef.current,
    })
    viewRef.current = view
    browserFocusedRef.current = document.visibilityState === 'visible' && document.hasFocus()
    const onWindowFocus = () => {
      browserFocusedRef.current = document.visibilityState === 'visible'
      refreshLineNumbers(view)
    }
    const onWindowBlur = () => {
      browserFocusedRef.current = false
      refreshLineNumbers(view)
    }
    const onVisibilityChange = () => {
      browserFocusedRef.current = document.visibilityState === 'visible' && document.hasFocus()
      refreshLineNumbers(view)
    }
    window.addEventListener('focus', onWindowFocus)
    window.addEventListener('blur', onWindowBlur)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('focus', onWindowFocus)
      window.removeEventListener('blur', onWindowBlur)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      view.destroy()
      viewRef.current = null
    }
  }, [queueLineNumberRefresh, refreshLineNumbers])

  // swap the CodeMirror theme when the resolved appearance changes
  useEffect(() => {
    const view = viewRef.current
    if (!view || appliedModeRef.current === resolvedMode) return
    view.dispatch({
      effects: themeCompartment.current.reconfigure(editorThemes[resolvedMode]),
    })
    appliedModeRef.current = resolvedMode
  }, [resolvedMode])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const load = ++vimLoadRef.current
    if (store.editorKeymap === 'standard') {
      vimTypingRef.current = false
      view.dispatch({ effects: vimCompartment.current.reconfigure([]) })
      refreshLineNumbers(view)
      return
    }

    void import('@replit/codemirror-vim')
      .then(({ getCM, vim, Vim }) => {
        if (
          load !== vimLoadRef.current ||
          editorKeymapRef.current !== 'vim' ||
          viewRef.current !== view
        ) {
          return
        }
        if (!vimKeysConfigured) {
          Vim.map('<Tab>', '<C-i>', 'normal')
          vimKeysConfigured = true
        }
        view.dispatch({
          effects: vimCompartment.current.reconfigure(vim({ status: true })),
        })
        getCM(view)?.on('vim-mode-change', ({ mode }: { mode: string }) => {
          vimTypingRef.current = mode === 'insert' || mode === 'replace'
          queueLineNumberRefresh(view)
        })
        refreshLineNumbers(view)
      })
      .catch((error: unknown) => {
        console.error('Failed to load Vim keybindings', error)
        vimTypingRef.current = false
        if (
          load === vimLoadRef.current &&
          editorKeymapRef.current === 'vim' &&
          viewRef.current === view
        ) {
          storeRef.current.setEditorKeymap('standard')
        }
      })
  }, [queueLineNumberRefresh, refreshLineNumbers, store.editorKeymap])

  useEffect(() => {
    const view = viewRef.current
    if (view) refreshLineNumbers(view)
  }, [refreshLineNumbers, store.editorLineNumbers])

  // reset document when the active file identity changes or its content is
  // replaced outside the editor (docRevision covers reloading the same file)
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const content =
      store.files.find((f) => f.name === store.activeFileName)?.content ?? ''
    if (content !== view.state.doc.toString()) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
        effects: languageCompartment.current.reconfigure(
          sourceLanguageExtension(store.activeFileName),
        ),
        annotations: programmaticUpdate.of(true),
      })
    } else {
      view.dispatch({
        effects: languageCompartment.current.reconfigure(
          sourceLanguageExtension(store.activeFileName),
        ),
        annotations: programmaticUpdate.of(true),
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.activeFileName, store.docRevision])

  // Yosys reports reliable source lines for frontend errors. Load CodeMirror's
  // diagnostics UI only after such an error occurs so it stays off the normal
  // editor startup path.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const load = ++diagnosticsLoadRef.current
    const source = store.error?.diagnostic
    const diagnostic =
      source?.file === store.activeFileName
        ? (() => {
            const lineNumber = Math.min(
              Math.max(source.line, 1),
              view.state.doc.lines,
            )
            const line = view.state.doc.line(lineNumber)
            const from =
              source.column == null
                ? line.from
                : Math.min(line.from + source.column - 1, line.to)
            return {
              from,
              to: source.column == null ? line.to : Math.min(from + 1, line.to),
              severity: 'error' as const,
              source: 'Yosys',
              message: source.message,
            }
          })()
        : null

    const apply = (
      setDiagnostics: typeof import('@codemirror/lint')['setDiagnostics'],
    ) => {
      if (load !== diagnosticsLoadRef.current || viewRef.current !== view) return
      view.dispatch(setDiagnostics(view.state, diagnostic ? [diagnostic] : []))
      if (diagnostic) {
        view.dispatch({
          effects: EditorView.scrollIntoView(diagnostic.from, { y: 'center' }),
        })
      }
    }

    if (setDiagnosticsRef.current) {
      apply(setDiagnosticsRef.current)
    } else if (diagnostic) {
      void import('@codemirror/lint')
        .then(({ setDiagnostics }) => {
          setDiagnosticsRef.current = setDiagnostics
          apply(setDiagnostics)
        })
        .catch((error: unknown) => {
          console.error('Failed to load editor diagnostics', error)
        })
    }
  }, [store.activeFileName, store.docRevision, store.error])

  // apply cross-probe highlight
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (!store.editorHighlight) {
      view.dispatch({
        effects: setHighlight.of(null),
        annotations: programmaticUpdate.of(true),
      })
      return
    }
    if (!store.editorHighlight.spans.some((span) => span.file === store.activeFileName)) {
      view.dispatch({
        effects: setHighlight.of(null),
        annotations: programmaticUpdate.of(true),
      })
      return
    }
    applyHighlight(view, store.editorHighlight, store.activeFileName)
  }, [store.editorHighlight, store.activeFileName])

  const activeFileIndex = Math.max(
    0,
    store.files.findIndex((file) => file.name === store.activeFileName),
  )
  return (
    <div
      className="editor-wrap"
      id="source-editor-panel"
      role="tabpanel"
      aria-labelledby={`source-file-tab-${activeFileIndex}`}
      ref={hostRef}
      onPointerEnter={() => {
        editorHoveredRef.current = true
        const view = viewRef.current
        if (view) refreshLineNumbers(view)
      }}
      onPointerLeave={() => {
        editorHoveredRef.current = false
        const view = viewRef.current
        if (view) refreshLineNumbers(view)
      }}
    />
  )
}
