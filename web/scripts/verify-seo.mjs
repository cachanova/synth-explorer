import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const canonicalUrl = 'https://www.synthexplorer.dev/'
const expectedTitle = 'Synth Explorer — Online Verilog & SystemVerilog Synthesis'
const distUrl = new URL('../dist/', import.meta.url)

const html = await readFile(new URL('index.html', distUrl), 'utf8')
assert.match(html, new RegExp(`<title>${expectedTitle.replace('&', '&amp;')}</title>`))
assert.match(html, /<meta\s+name="description"\s+content="[^"]+"\s*\/?>/)
assert.match(html, /<meta\s+name="robots"\s+content="index, follow"\s*\/?>/)
assert.match(
  html,
  new RegExp(`<link\\s+rel="canonical"\\s+href="${canonicalUrl}"\\s*/?>`),
)
assert.match(html, /<meta\s+property="og:image"\s+content="https:\/\/www\.synthexplorer\.dev\/og-image\.png"\s*\/?>/)
assert.match(html, /<meta\s+name="twitter:card"\s+content="summary_large_image"\s*\/?>/)

const jsonLdMatch = html.match(
  /<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/,
)
assert(jsonLdMatch, 'index.html must contain JSON-LD')
const jsonLd = JSON.parse(jsonLdMatch[1])
assert.equal(jsonLd['@type'], 'WebApplication')
assert.equal(jsonLd.name, 'Synth Explorer')
assert.equal(jsonLd.url, canonicalUrl)
assert.equal(jsonLd.offers.price, '0')

const robots = await readFile(new URL('robots.txt', distUrl), 'utf8')
assert.match(robots, /^User-agent: \*$/m)
assert.match(robots, /^Allow: \/$/m)
assert.match(robots, new RegExp(`^Sitemap: ${canonicalUrl}sitemap\\.xml$`, 'm'))
assert.doesNotMatch(robots, /<html/i)

const sitemap = await readFile(new URL('sitemap.xml', distUrl), 'utf8')
assert.match(sitemap, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/)
assert.match(sitemap, new RegExp(`<loc>${canonicalUrl}</loc>`))

const image = await readFile(new URL('og-image.png', distUrl))
assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
assert.equal(image.readUInt32BE(16), 1200)
assert.equal(image.readUInt32BE(20), 630)

console.log('SEO artifacts verified')
