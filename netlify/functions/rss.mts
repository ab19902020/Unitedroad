// Generic server-side RSS/Atom feed proxy.
//
// The site used to fetch every secondary feed (news, transfers, academy,
// social hub, archive/videos) straight from the browser through
// rss2json.com, with an API key embedded in the page source. That key was
// shared by every visitor, the free-tier quota was trivially exhausted by
// the page's own polling (several feeds, refetched every 60-120 seconds,
// from every open tab), and once the quota was gone every feed on the site
// silently went blank. rss2json's own response caching also meant fresh
// posts could take a long time to surface even when requests succeeded.
//
// This function fetches the requested feed directly from this server on
// each call, parses RSS 2.0 (<item>) and Atom (<entry>) alike, and returns
// JSON in the same shape the page already consumes. No third-party key,
// no shared quota.

const firstMatch = (block: string, tag: string): string => {
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

const decodeEntities = (s: string): string =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")

// Atom <link> is usually a self-closing tag with an href attribute
// (<link href="..."/> or <link rel="alternate" href="..."/>), unlike RSS
// where <link> wraps the URL as text content.
const getLink = (block: string): string => {
  const textLink = firstMatch(block, 'link')
  if (textLink && !textLink.includes('<')) return textLink

  const altLink = block.match(/<link[^>]+rel="alternate"[^>]+href="([^"]*)"/i)
  if (altLink) return altLink[1]

  const anyLink = block.match(/<link[^>]+href="([^"]*)"/i)
  if (anyLink) return anyLink[1]

  return textLink
}

const getAuthor = (block: string): string => {
  const dcCreator = firstMatch(block, 'dc:creator')
  if (dcCreator) return dcCreator

  const authorBlock = firstMatch(block, 'author')
  if (authorBlock) {
    const name = firstMatch(authorBlock, 'name')
    return name || authorBlock
  }
  return ''
}

const getThumbnail = (block: string, content: string): string => {
  const mediaThumb = attrMatch(block, 'media:thumbnail', 'url')
  if (mediaThumb) return mediaThumb

  const enclosure = attrMatch(block, 'enclosure', 'url')
  if (enclosure) return enclosure

  const mediaContent = attrMatch(block, 'media:content', 'url')
  if (mediaContent) return mediaContent

  const imgMatch = content.match(/<img[^>]+src="([^">]+)"/i)
  if (imgMatch) return imgMatch[1]

  return ''
}

const parseFeed = (xml: string) => {
  const isAtom = !/<item[\s\S]*?>/i.test(xml) && /<entry[\s\S]*?>/i.test(xml)
  const blocks = isAtom
    ? xml.match(/<entry[\s\S]*?<\/entry>/gi) || []
    : xml.match(/<item[\s\S]*?<\/item>/gi) || []

  return blocks.map((block) => {
    const rawDescription = firstMatch(block, 'description') || firstMatch(block, 'summary')
    const content =
      firstMatch(block, 'content:encoded') || firstMatch(block, 'content') || rawDescription
    const description = rawDescription || content

    const guid = firstMatch(block, 'guid') || firstMatch(block, 'id')
    const pubDate =
      firstMatch(block, 'pubDate') || firstMatch(block, 'published') || firstMatch(block, 'updated')

    return {
      title: decodeEntities(firstMatch(block, 'title')),
      link: getLink(block).trim(),
      guid,
      pubDate,
      author: getAuthor(block) || 'Unknown',
      description: decodeEntities(description),
      content,
      thumbnail: getThumbnail(block, content),
      enclosure: { link: getThumbnail(block, content) },
    }
  })
}

export default async (req: Request) => {
  const feedUrl = new URL(req.url).searchParams.get('url')

  if (!feedUrl || !/^https?:\/\//i.test(feedUrl)) {
    return Response.json(
      { status: 'error', message: 'A valid "url" query parameter is required.', items: [] },
      { status: 400 },
    )
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)

    const res = await fetch(feedUrl, {
      headers: {
        'User-Agent': 'UnitedRoadFeedBot/1.0 (+https://unitedroad.uk)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
      },
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout))

    if (!res.ok) {
      return Response.json(
        { status: 'error', message: `Upstream feed responded ${res.status}`, items: [] },
        { status: 502 },
      )
    }

    const xml = await res.text()
    const items = parseFeed(xml)

    return Response.json(
      { status: 'ok', items },
      // Let Netlify's CDN share one upstream fetch across visitors for a
      // couple of minutes instead of every browser hitting the news site
      // directly on every poll, while keeping things reasonably fresh.
      { headers: { 'Cache-Control': 'public, max-age=0, s-maxage=120, stale-while-revalidate=300' } },
    )
  } catch (err) {
    return Response.json(
      { status: 'error', message: (err as Error).message, items: [] },
      { status: 500 },
    )
  }
}

export const config = {
  path: '/api/rss',
}
