import manifest from '../data/examples/manifest.json'
import type { ExamplesResponse } from '../types'

const sources = import.meta.glob<string>('../data/examples/*.{v,sv,vhd,vhdl}', {
  query: '?raw',
  import: 'default',
  eager: true,
})

export function bundledExamples(): ExamplesResponse {
  return {
    examples: manifest.flatMap((entry) => {
      let complete = true
      const variants = Object.fromEntries(
        Object.entries(entry.variants).map(([language, variant]) => {
          const files = variant.files.flatMap((name) => {
            const content = sources[`../data/examples/${name}`]
            return content == null ? [] : [{ name, content }]
          })
          if (files.length !== variant.files.length) complete = false
          return [language, { top: variant.top, files }]
        }),
      ) as ExamplesResponse['examples'][number]['variants']
      return complete ? [{ ...entry, variants }] : []
    }),
  }
}
