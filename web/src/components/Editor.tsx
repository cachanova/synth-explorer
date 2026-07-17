import { useEffect, useRef } from 'react'
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
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  type DecorationSet,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { verilog } from '@codemirror/legacy-modes/mode/verilog'
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

const editorTheme = (mode: 'light' | 'dark'): Extension => [
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
    { dark: mode === 'dark' },
  ),
  syntaxHighlighting(appHighlightStyle),
]

// --- src highlight state ---
const setHighlight = StateEffect.define<
  { from: number; primary: boolean }[] | null
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
            e.value.map(({ from, primary }) =>
              (primary ? primaryLine : secondaryLine).range(from),
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
  const decorations = [...linePriority.entries()]
    .sort(([a], [b]) => a - b)
    .map(([line, primary]) => ({ from: doc.line(line).from, primary }))

  const primaryLineNumber =
    primarySpan?.file === activeFile
      ? Math.min(Math.max(primarySpan.startLine, 1), doc.lines)
      : decorations.length > 0
        ? doc.lineAt(decorations[0].from).number
        : 1
  const primaryPosition = doc.line(primaryLineNumber).from
  view.dispatch({
    selection: { anchor: primaryPosition },
    effects: [
      setHighlight.of(decorations),
      EditorView.scrollIntoView(primaryPosition, { y: 'center' }),
    ],
    annotations: programmaticUpdate.of(true),
  })
}

function selectedLines(state: EditorState): { startLine: number; endLine: number } {
  const selection = state.selection.main
  const startLine = state.doc.lineAt(selection.from).number
  let endLine = state.doc.lineAt(selection.to).number
  if (
    selection.from !== selection.to &&
    selection.to === state.doc.line(endLine).from
  ) {
    endLine = Math.max(startLine, endLine - 1)
  }
  return { startLine, endLine }
}

export function Editor() {
  const store = useStore(
    ({
      files,
      activeFileName,
      docRevision,
      editorHighlight,
      updateFileContent,
      setSourceSelection,
      clearGraphSelection,
      synthesize,
    }) => ({
      files,
      activeFileName,
      docRevision,
      editorHighlight,
      updateFileContent,
      setSourceSelection,
      clearGraphSelection,
      synthesize,
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
  const resolvedModeRef = useRef(resolvedMode)
  resolvedModeRef.current = resolvedMode

  // create the view once
  useEffect(() => {
    if (!hostRef.current) return
    const initial =
      storeRef.current.files.find((f) => f.name === storeRef.current.activeFileName)
        ?.content ?? ''

    const updateListener = EditorView.updateListener.of((u) => {
      if (u.transactions.some((tr) => tr.annotation(programmaticUpdate))) return
      if (u.docChanged) {
        const text = u.state.doc.toString()
        storeRef.current.updateFileContent(currentFileRef.current, text)
      }
      if (u.selectionSet || u.docChanged) {
        const { startLine, endLine } = selectedLines(u.state)
        storeRef.current.setSourceSelection(
          currentFileRef.current,
          startLine,
          endLine,
        )
      }
    })

    const synthKeymap = keymap.of([
      {
        key: 'Escape',
        preventDefault: true,
        run: () => {
          storeRef.current.clearGraphSelection()
          return true
        },
      },
      {
        key: 'Mod-Enter',
        preventDefault: true,
        run: () => {
          void storeRef.current.synthesize()
          return true
        },
      },
    ])

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      history(),
      StreamLanguage.define(verilog),
      themeCompartment.current.of(editorTheme(resolvedModeRef.current)),
      highlightField,
      synthKeymap,
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      updateListener,
      EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto' } }),
    ]

    const view = new EditorView({
      state: EditorState.create({ doc: initial, extensions }),
      parent: hostRef.current,
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [])

  // swap the CodeMirror theme when the resolved appearance changes
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: themeCompartment.current.reconfigure(editorTheme(resolvedMode)),
    })
  }, [resolvedMode])

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
        annotations: programmaticUpdate.of(true),
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.activeFileName, store.docRevision])

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
    />
  )
}
