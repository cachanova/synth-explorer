import { expect, test } from '@playwright/test'

const canonicalUrl = 'https://www.synthexplorer.dev/'

test('publishes crawlable metadata and semantic product identity', async ({ page }) => {
  await page.goto('/')

  await expect(page).toHaveTitle(
    'Synth Explorer - Online RTL Synthesis Exploration and Analysis',
  )
  await expect(page.getByRole('heading', { level: 1, name: 'Synth Explorer' })).toBeVisible()
  await expect(
    page.getByText('Browser-based RTL synthesis & circuit analysis', { exact: true }),
  ).toBeVisible()

  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    /Synthesize RTL in your browser and explore logic paths/,
  )
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    canonicalUrl,
  )
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    'content',
    `${canonicalUrl}og-image.png`,
  )
})

test('serves valid crawler discovery files', async ({ request }) => {
  const robots = await request.get('/robots.txt')
  expect(robots.ok()).toBe(true)
  expect(robots.headers()['content-type']).toContain('text/plain')
  await expect(robots.text()).resolves.toContain(
    `Sitemap: ${canonicalUrl}sitemap.xml`,
  )

  const sitemap = await request.get('/sitemap.xml')
  expect(sitemap.ok()).toBe(true)
  expect(sitemap.headers()['content-type']).toMatch(/application\/xml|text\/xml/)
  await expect(sitemap.text()).resolves.toContain(`<loc>${canonicalUrl}</loc>`)
})
