// Minimal RSS 2.0 / Atom parser shared by the article-writing pipeline.
//
// This is deliberately dependency-free and regex-based, matching the approach
// already used by netlify/functions/rss.mts. The feeds we read are small and
// well-formed enough that a full XML parser would be more weight than value in
// a function that runs once a day.

export type FeedItem = {
  title: string
  link: string
  pubDate: string
  timestamp: number
  description: string
  thumbnail: string
  source: string
}

const firstMatch = (block: string, tag: string): string => {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')
  const m = block.match(re)
  if (!m) return ''
  return m[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim()
}

const attrMatch = (block: string, tag: string, attr: string): string => {
  const re = new RegExp(`<${tag}[^>]*\\b${attr}="([^"]*)"[^>]*/?>`, 'i')
  const m = block.match(re)
  return m ? m[1] : ''
}

const NAMED_ENTITIES: Record<string, string> = {
  lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  amp: '&', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  hellip: '…', mdash: '—', ndash: '–', pound: '£', euro: '€',
}

// Publishers escape curly quotes and dashes as numeric references far more
// often than named ones, and an un-decoded "&#8217;" in a headline reads as a
// bug both on the page and in the prompt we hand the model.
const decodeEntities = (s: string): string =>
  String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[String(name).toLowerCase()] ?? m)

export const stripTags = (s: string): string =>
  decodeEntities(String(s || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()

const getLink = (block: string): string => {
  const textLink = firstMatch(block, 'link')
  if (textLink && !textLink.includes('<')) return textLink
  const alt = block.match(/<link[^>]+rel="alternate"[^>]+href="([^"]*)"/i)
  if (alt) return alt[1]
  const any = block.match(/<link[^>]+href="([^"]*)"/i)
  if (any) return any[1]
  return textLink
}

export const parseFeed = (xml: string, source: string): FeedItem[] => {
  const isAtom = !/<item[\s\S]*?>/i.test(xml) && /<entry[\s\S]*?>/i.test(xml)
  const blocks = isAtom
    ? xml.match(/<entry[\s\S]*?<\/entry>/gi) || []
    : xml.match(/<item[\s\S]*?<\/item>/gi) || []

  return blocks.map((block) => {
    const content =
      firstMatch(block, 'content:encoded') ||
      firstMatch(block, 'description') ||
      firstMatch(block, 'summary') ||
      firstMatch(block, 'content')

    const pubDate =
      firstMatch(block, 'pubDate') || firstMatch(block, 'published') || firstMatch(block, 'updated')

    const parsed = Date.parse(pubDate)

    const inlineImg = content.match(/<img[^>]+src="([^">]+)"/i)

    return {
      title: stripTags(firstMatch(block, 'title')),
      link: getLink(block).trim(),
      pubDate,
      timestamp: Number.isNaN(parsed) ? 0 : parsed,
      description: stripTags(content).slice(0, 900),
      thumbnail:
        attrMatch(block, 'media:thumbnail', 'url') ||
        attrMatch(block, 'enclosure', 'url') ||
        attrMatch(block, 'media:content', 'url') ||
        (inlineImg ? inlineImg[1] : ''),
      source,
    }
  })
}

// Fetch one feed, never throwing: a single dead publisher must not take the
// whole daily run down with it.
export const fetchFeed = async (url: string, source: string, timeoutMs = 9000): Promise<FeedItem[]> => {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'UnitedRoadFeedBot/1.0 (+https://unitedroad.uk)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
      },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer))

    if (!res.ok) return []
    return parseFeed(await res.text(), source)
  } catch {
    return []
  }
}
