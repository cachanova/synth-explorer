import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const canonicalUrl = 'https://www.synthexplorer.dev/'
const expectedTitle = 'Synth Explorer - Online RTL Synthesis Exploration and Analysis'
const expectedDescription =
  'Synthesize RTL in your browser and explore logic paths, endpoints, fanin, fanout, and source locations. Your RTL stays local.'
const distUrl = new URL('../dist/', import.meta.url)

const html = await readFile(new URL('index.html', distUrl), 'utf8')

function metaContent(attribute, value) {
  const match = html.match(
    new RegExp(`<meta\\s+${attribute}="${value}"\\s+content="([^"]+)"\\s*/?>`),
  )
  assert(match, `index.html must contain ${attribute}="${value}" metadata`)
  return match[1]
}

assert.match(html, new RegExp(`<title>${expectedTitle}</title>`))
assert.equal(metaContent('name', 'description'), expectedDescription)
assert.match(html, /<meta\s+name="robots"\s+content="index, follow"\s*\/?>/)
assert.match(
  html,
  new RegExp(`<link\\s+rel="canonical"\\s+href="${canonicalUrl}"\\s*/?>`),
)
assert.equal(metaContent('property', 'og:title'), expectedTitle)
assert.equal(metaContent('property', 'og:description'), expectedDescription)
assert.equal(metaContent('property', 'og:image'), `${canonicalUrl}og-image.png`)
assert.equal(metaContent('name', 'twitter:card'), 'summary_large_image')
assert.equal(metaContent('name', 'twitter:title'), expectedTitle)
assert.equal(metaContent('name', 'twitter:description'), expectedDescription)
assert.match(html, /<h1 class="logo" aria-label="Synth Explorer">/)
assert.doesNotMatch(html, /class="tagline"/)

const jsonLdMatch = html.match(
  /<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/,
)
assert(jsonLdMatch, 'index.html must contain JSON-LD')
const jsonLd = JSON.parse(jsonLdMatch[1])
assert.equal(jsonLd['@type'], 'WebSite')
assert.equal(jsonLd.name, 'Synth Explorer')
assert.equal(jsonLd.alternateName, 'synthexplorer.dev')
assert.equal(jsonLd.url, canonicalUrl)
assert.equal(jsonLd.description, expectedDescription)

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
