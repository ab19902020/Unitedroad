// Sitemap covering the site's own writing plus its static sections.
//
// Without this, a crawler has no way to discover an article: the SPA's internal
// links are rendered by JavaScript, and there is no server-side index page
// listing them.

import type { Config } from '@netlify/functions'
import { readIndex } from '../lib/article-writer.mts'
import { articleUrl } from '../lib/seo.mts'

const SITE = 'https://unitedroad.uk'

// Hash routes are not separately indexable, so the static sections are listed
// at the root only. The articles are what carry the long-tail search value.
const SECTIONS = ['', '/#/news', '/#/transfers', '/#/articles', '/#/games', '/#/manager', '/#/vault']

export default async () => {
  const index = await readIndex()

  const urls = [
    ...SECTIONS.map((p) => ({ loc: `${SITE}${p}`, lastmod: new Date().toISOString(), pri: p === '' ? '1.0' : '0.7' })),
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
