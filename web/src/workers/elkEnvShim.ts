// Interop shim for elkjs' bundled build inside a real Web Worker.
//
// elk.bundled.js inlines elk-worker.min.js, whose module body checks
//   typeof document === 'undefined' && typeof self !== 'undefined'
// to decide whether it *is* the worker script. Inside our own Web Worker that
// check is true, so it installs its own self.onmessage and never exports the
// fake synchronous `Worker` class that elk's main-node entry then constructs
// (`new require('./elk-worker.min.js').Worker(url)` -> "not a constructor").
//
// Defining a stub `document` before elk.bundled.js evaluates forces the
// library down its main-thread path: it exports the fake Worker, and
// `elk.layout()` runs synchronously right here in this worker thread — which
// is the whole point (layout stays off the UI thread).
//
// Safe because the only other `document` use in the bundle is inside an
// MSIE-only branch that never executes in a modern browser.
const g = globalThis as Record<string, unknown>
if (typeof g.document === 'undefined') {
  g.document = {}
}

export {}
