// The site's own RSS feed.
//
// Every other United site publishes one; this is how aggregators, Feedly and
// Google News discover new stories without waiting for a crawl.

import type { Config } from '@netlify/functions'
import { readIndex } from '../lib/article-writer.mts'
import { articleUrl } from '../lib/seo.mts'

const SITE = 'https://unitedroad.uk'

const cdata = (s: string) => `<![CDATA[${String(s || '').replace(/]]>/g, ']]&gt;')}]]>`

export default async () => {
  const index = await readIndex()
  const items = index.articles.slice(0, 50)

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>United Road</title>
  <link>${SITE}</link>
  <description>Manchester United news, transfers and analysis.</description>
  <language>en-gb</language>
  <lastBuildDate>${new Date(items[0]?.timestamp || Date.now()).toUTCString()}</lastBuildDate>
  <atom:link href="${SITE}/feed.xml" rel="self" type="application/rss+xml"/>
${items.map((a) => `  <item>
    <title>${cdata(a.title)}</title>
    <link>${articleUrl(a.id)}</link>
    <guid isPermaLink="true">${articleUrl(a.id)}</guid>
    <pubDate>${new Date(a.timestamp).toUTCString()}</pubDate>
    <dc:creator>${cdata(a.author)}</dc:creator>
    <category>${cdata(a.category || 'News')}</category>
    <description>${cdata(a.standfirst || a.excerpt || '')}</description>
    <content:encoded>${cdata(a.content)}</content:encoded>
  </item>`).join('\n')}
</channel>
</rss>`

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=0, s-maxage=600',
    },
  })
}

export const config: Config = { path: '/feed.xml' }
