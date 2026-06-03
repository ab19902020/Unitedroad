// Server-side Substack feed proxy.
//
// The site previously fetched the Substack RSS feed through the third-party
// rss2json.com service from the browser. That service caches the converted
// feed on its own infrastructure, so freshly published posts could take a long
// time to appear no matter how aggressively the client tried to bust the cache.
//
// This function fetches the Substack RSS feed directly each time it is invoked
// (Netlify Functions are not cached unless we opt in), parses it, and returns a
// JSON payload in the same shape the page already consumes. This removes the
// external dependency entirely and guarantees the page always reads a feed that
// is at most as stale as Substack's own RSS endpoint.

const SUBSTACK_FEED = 'https://adam730708.substack.com/feed'

const firstMatch = (block: string, tag: string): string => {
  // Handles both <tag>value</tag> and namespaced <ns:tag>value</ns:tag>,
  // with or without CDATA wrappers.
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')
  const m = block.match(re)
  if (!m) return ''
  return m[1]
    .replace(/^<!\[CDATA\[/, '')
    .replace(/\]\]>$/, '')
    .trim()
}

const attrMatch = (block: string, tag: string, attr: string): string => {
  const re = new RegExp(`<${tag}[^>]*\\b${attr}="([^"]*)"[^>]*/?>`, 'i')
  const m = block.match(re)
  return m ? m[1] : ''
}

export default async (_req: Request) => {
  try {
    // Append a timestamp so any intermediary CDN on Substack's side is bypassed.
    const res = await fetch(`${SUBSTACK_FEED}?_cb=${Date.now()}`, {
      headers: {
        // A real User-Agent avoids the occasional bot-block on RSS endpoints.
        'User-Agent': 'UnitedRoadFeedBot/1.0 (+https://unitedroad.uk)',
        Accept: 'application/rss+xml, application/xml, text/xml',
      },
    })

    if (!res.ok) {
      return Response.json(
        { status: 'error', message: `Upstream feed responded ${res.status}`, items: [] },
        { status: 502 },
      )
    }

    const xml = await res.text()
    const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) || []

    const items = itemBlocks.map((block) => {
      const content = firstMatch(block, 'content:encoded') || firstMatch(block, 'description')
      const description = firstMatch(block, 'description') || content

      // Prefer an explicit enclosure image, then fall back to the first image
      // found inside the post body.
      let thumbnail = attrMatch(block, 'enclosure', 'url')
      if (!thumbnail) {
        const imgMatch = content.match(/<img[^>]+src="([^">]+)"/i)
        if (imgMatch) thumbnail = imgMatch[1]
      }

      return {
        title: firstMatch(block, 'title'),
        link: firstMatch(block, 'link'),
        guid: firstMatch(block, 'guid'),
        pubDate: firstMatch(block, 'pubDate'),
        author: firstMatch(block, 'dc:creator') || 'United Road Editorial',
        description,
        content,
        thumbnail,
        enclosure: thumbnail ? { link: thumbnail } : {},
      }
    })

    return Response.json(
      { status: 'ok', items },
      // Never let the browser or Netlify CDN serve a stale copy of this response.
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    return Response.json(
      { status: 'error', message: (err as Error).message, items: [] },
      { status: 500 },
    )
  }
}

export const config = {
  path: '/api/substack',
}
