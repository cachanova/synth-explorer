import type { LayoutEngine } from '../lib/layout'

/**
 * Browser-only worker construction lives outside the reusable layout module so
 * SchemWeave's worker can import the canonical adapter without recursively
 * bundling either layout worker entrypoint.
 */
export function createLayoutWorker(engine: LayoutEngine): Worker {
  return engine === 'schemweave'
    ? new Worker(
        new URL('./schemweave.worker.ts', import.meta.url),
        { type: 'module' },
      )
    : new Worker(
        new URL('./elk.worker.ts', import.meta.url),
        { type: 'module' },
      )
}
