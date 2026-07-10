import { useEffect, useRef } from 'react'
import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state'
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
import { StreamLanguage } from '@codemirror/language'
import { verilog } from '@codemirror/legacy-modes/mode/verilog'
import { oneDark } from '@codemirror/theme-one-dark'
import { useStore } from '../store'
import type { EditorHighlight } from '../store'

// --- src highlight state ---
const setHighlight = StateEffect.define<{ from: number; to: number } | null>()
const hlMark = Decoration.mark({ class: 'cm-src-hl' })

const highlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(deco, tr) {
    let next = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(setHighlight)) {
        if (e.value == null) next = Decoration.none
        else next = Decoration.set([hlMark.range(e.value.from, e.value.to)])
      }
    }
    return next
  },
  provide: (f) => EditorView.decorations.from(f),
})

function applyHighlight(view: EditorView, hl: EditorHighlight) {
  const doc = view.state.doc
  const { span } = hl
  const startLine = Math.min(Math.max(span.startLine, 1), doc.lines)
  const endLine = Math.min(Math.max(span.endLine, startLine), doc.lines)
  const lineStart = doc.line(startLine)
  const lineEnd = doc.line(endLine)
  // Use the whole line range so single-column spans are still visible.
  const from = lineStart.from
  const to = lineEnd.to
  view.dispatch({
    effects: [setHighlight.of({ from, to }), EditorView.scrollIntoView(from, { y: 'center' })],
  })
  // fade the highlight out after a moment
  window.setTimeout(() => {
    view.dispatch({ effects: setHighlight.of(null) })
  }, 2200)
}

export function Editor() {
  const store = useStore()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)

  // stable refs so the editor is created once
  const storeRef = useRef(store)
  storeRef.current = store
  const currentFileRef = useRef(store.activeFileName)
  currentFileRef.current = store.activeFileName

  // create the view once
  useEffect(() => {
    if (!hostRef.current) return
    const initial =
      storeRef.current.files.find((f) => f.name === storeRef.current.activeFileName)
        ?.content ?? ''

    const updateListener = EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        const text = u.state.doc.toString()
        storeRef.current.updateFileContent(currentFileRef.current, text)
      }
      if (u.selectionSet || u.docChanged) {
        const line = u.state.doc.lineAt(u.state.selection.main.head).number
        storeRef.current.setCursor(currentFileRef.current, line)
      }
    })

    const synthKeymap = keymap.of([
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
      oneDark,
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

  // reset document when the active file identity changes
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const content =
      store.files.find((f) => f.name === store.activeFileName)?.content ?? ''
    if (content !== view.state.doc.toString()) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.activeFileName])

  // apply cross-probe highlight
  useEffect(() => {
    const view = viewRef.current
    if (!view || !store.editorHighlight) return
    if (store.editorHighlight.span.file !== store.activeFileName) return
    applyHighlight(view, store.editorHighlight)
  }, [store.editorHighlight, store.activeFileName])

  return <div className="editor-wrap" ref={hostRef} />
}
