import manifest from '../data/examples/manifest.json'
import type { ExamplesResponse } from '../types'

const sources = import.meta.glob<string>('../data/examples/*.{v,sv}', {
  query: '?raw',
  import: 'default',
  eager: true,
})

export function bundledExamples(): ExamplesResponse {
  return {
    examples: manifest.flatMap((entry) => {
      const files = entry.files.flatMap((name) => {
        const content = sources[`../data/examples/${name}`]
        return content == null ? [] : [{ name, content }]
      })
      return files.length === entry.files.length ? [{ ...entry, files }] : []
    }),
  }
}
