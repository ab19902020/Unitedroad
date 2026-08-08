// Sitemap covering the site's own writing plus its static sections.
//
// Without this, a crawler has no way to discover an article: the SPA's internal
// links are rendered by JavaScript, and there is no server-side index page
// listing them.

import type { Config } from '@netlify/functions'
import { readIndex } from '../lib/article-writer.mts'
import { articleUrl } from '../lib/seo.mts'

const SITE = 'https://unitedroad.uk'

// Every section now has a real URL rather than a fragment, so each one can be
// listed and indexed in its own right. Keep this in step with the redirects in
// netlify.toml: a path listed here but not rewritten there is a 404 in the
// sitemap, which is worse than not listing it at all.
//
// Priorities say which pages we would rather rank. The sections that carry
// writing come first; the legal and admin pages are listed so they are
// discoverable, and no higher.
const SECTIONS: [string, string][] = [
  ['', '1.0'],
  ['/news', '0.9'],
  ['/articles', '0.9'],
  ['/transfers', '0.9'],
  ['/academy', '0.7'],
  ['/matchday', '0.7'],
  ['/hub', '0.6'],
  ['/vault', '0.7'],
  ['/videos', '0.6'],
  ['/oracle', '0.5'],
  ['/games', '0.6'],
  ['/manager', '0.6'],
  ['/about', '0.4'],
  ['/author', '0.4'],
  ['/standards', '0.4'],
  ['/contact', '0.3'],
  ['/privacy', '0.2'],
  ['/terms', '0.2'],
]

export default async () => {
  const index = await readIndex()

  const urls = [
    ...SECTIONS.map(([p, pri]) => ({ loc: `${SITE}${p || '/'}`, lastmod: new Date().toISOString(), pri })),
    ...index.articles.map((a) => ({
      loc: articleUrl(a.id),
      lastmod: new Date(a.timestamp).toISOString(),
      pri: '0.8',
    })),
  ]

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u.loc}</loc><lastmod>${u.lastmod}</lastmod><priority>${u.pri}</priority></url>`).join('\n')}
</urlset>`

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=0, s-maxage=1800',
    },
  })
}

export const config: Config = { path: '/sitemap.xml' }
