// The automated United Road article desk.
//
// Once a day (or on demand) this: pulls the same Manchester United feeds the
// site already reads, filters them down to genuinely United-relevant items the
// desk has not already covered, hands them to DeepSeek with the United Road
// editorial brain, sanitises what comes back, and stores it in Netlify Blobs
// where /api/articles serves it to the site.
//
// The DeepSeek key lives only in the DEEPSEEK_API_KEY environment variable and
// is never sent to the browser — every call happens here, on the server.

import { getStore } from '@netlify/blobs'
import { fetchFeed, stripTags, type FeedItem } from './feed.mts'
import { UNITED_ROAD_BRAIN, angleForDate, ANGLES, type Angle } from './brain.mts'

const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions'
const DEFAULT_MODEL = 'deepseek-v4-flash'
const STORE_NAME = 'united-road-articles'
const INDEX_KEY = 'index.json'

// How many past headlines we keep around purely to avoid re-writing the same
// story two days running.
const COVERED_MEMORY = 60

export type StoredArticle = {
  id: string
  title: string
  standfirst: string
  excerpt: string
  content: string
  tags: string[]
  category: string
  author: string
  isAI: true
  angle: string
  image: string
  date: string
  timestamp: number
  readMinutes: number
  sources: { title: string; link: string; source: string }[]
  model: string
}

type Index = {
  updatedAt: number
  covered: { title: string; at: number }[]
  articles: StoredArticle[]
}

const EMPTY_INDEX: Index = { updatedAt: 0, covered: [], articles: [] }

// --- Sources -------------------------------------------------------------

// Same publishers the site's news and transfer pages already trust.
const FEEDS: { url: string; source: string; transferHeavy?: boolean }[] = [
  { url: 'https://www.manchestereveningnews.co.uk/sport/football/manchester-united-fc/?service=rss', source: 'Manchester Evening News' },
  { url: 'https://www.manchestereveningnews.co.uk/sport/football/transfer-news/?service=rss', source: 'Manchester Evening News', transferHeavy: true },
  { url: 'http://feeds.bbci.co.uk/sport/football/teams/manchester-united/rss.xml', source: 'BBC Sport' },
  { url: 'https://www.skysports.com/rss/11065', source: 'Sky Sports', transferHeavy: true },
  { url: 'https://www.theguardian.com/football/manchester-united/rss', source: 'The Guardian' },
  { url: 'https://www.independent.co.uk/sport/football/teams/manchester-united/rss', source: 'The Independent' },
  { url: 'https://thepeoplesperson.com/feed/', source: 'The Peoples Person' },
  { url: 'https://strettynews.com/feed/', source: 'Stretty News' },
  { url: 'https://thebusbybabe.sbnation.com/rss/index.xml', source: 'The Busby Babe' },
  { url: 'https://ir.manutd.com/rss/news-releases.aspx', source: 'Manchester United (official)' },
]

const UNITED_TERMS = [
  'manchester united', 'man utd', 'man united', 'mufc', 'old trafford', 'red devils',
  'carrington', 'stretford', 'united',
]

const TRANSFER_TERMS = [
  'transfer', 'sign', 'signing', 'bid', 'fee', 'contract', 'loan', 'medical',
  'here we go', 'agreement', 'agent', 'target', 'talks', 'deal', 'move',
]

const FOUR_DAYS = 4 * 24 * 60 * 60 * 1000

const isAboutUnited = (item: FeedItem, trusted: boolean): boolean => {
  if (trusted) return true
  const text = `${item.title} ${item.description}`.toLowerCase()
  return UNITED_TERMS.some((t) => text.includes(t))
}

// Trim a headline down to something we can compare across outlets, so "United
// close on X" and "Man Utd close in on X" are recognised as the same story.
const normaliseTitle = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(man utd|man united|manchester united|mufc|united|the|a|an|of|for|to|on|in|as|is|it)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const overlapRatio = (a: string, b: string): number => {
  const wa = new Set(a.split(' ').filter((w) => w.length > 3))
  const wb = new Set(b.split(' ').filter((w) => w.length > 3))
  if (!wa.size || !wb.size) return 0
  let shared = 0
  wa.forEach((w) => { if (wb.has(w)) shared++ })
  return shared / Math.min(wa.size, wb.size)
}

export const gatherSourceMaterial = async (angle: Angle, covered: Index['covered']): Promise<FeedItem[]> => {
  const results = await Promise.all(
    FEEDS.map(async (f) => {
      const items = await fetchFeed(f.url, f.source)
      // The dedicated United feeds are United by definition; the general sport
      // feeds need keyword filtering.
      const trusted = f.url.includes('manchester-united') || f.url.includes('manutd') ||
        f.url.includes('thepeoplesperson') || f.url.includes('strettynews') || f.url.includes('busbybabe')
      return items
        .filter((i) => i.title && i.link)
        .filter((i) => isAboutUnited(i, trusted))
        .map((i) => ({ ...i, source: f.source }))
    }),
  )

  const cutoff = Date.now() - FOUR_DAYS
  let combined = results.flat().filter((i) => !i.timestamp || i.timestamp >= cutoff)

  // De-duplicate by link, then by near-identical headline across outlets.
  const byLink = new Map<string, FeedItem>()
  combined.forEach((i) => { if (!byLink.has(i.link)) byLink.set(i.link, i) })
  combined = [...byLink.values()]

  const unique: FeedItem[] = []
  combined
    .sort((a, b) => b.timestamp - a.timestamp)
    .forEach((item) => {
      const key = normaliseTitle(item.title)
      if (unique.some((u) => overlapRatio(normaliseTitle(u.title), key) > 0.75)) return
      unique.push(item)
    })

  // Drop anything we already published about recently.
  const fresh = unique.filter(
    (item) => !covered.some((c) => overlapRatio(normaliseTitle(c.title), normaliseTitle(item.title)) > 0.7),
  )

  // Transfer-angled days lead with transfer stories, everything else keeps
  // recency order.
  if (angle.id === 'transfer') {
    const score = (i: FeedItem) => {
      const t = `${i.title} ${i.description}`.toLowerCase()
      return TRANSFER_TERMS.filter((k) => t.includes(k)).length
    }
    fresh.sort((a, b) => score(b) - score(a) || b.timestamp - a.timestamp)
  }

  // One prolific blog can otherwise supply the entire brief, which produces a
  // narrow article. Round-robin across outlets so the model always sees the
  // story from more than one desk.
  const bySource = new Map<string, FeedItem[]>()
  fresh.forEach((item) => {
    const bucket = bySource.get(item.source) || []
    bucket.push(item)
    bySource.set(item.source, bucket)
  })

  const spread: FeedItem[] = []
  for (let round = 0; round < 5 && spread.length < 18; round++) {
    for (const bucket of bySource.values()) {
      if (bucket[round]) spread.push(bucket[round])
      if (spread.length >= 18) break
    }
  }

  return spread
}

// --- Sanitising ----------------------------------------------------------

const ALLOWED_TAGS = ['p', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote', 'strong', 'em', 'b', 'i', 'a', 'br']

// The model's HTML is injected into the page, so it is treated as untrusted
// input: strip every element we did not ask for, every attribute except a
// plain http(s) href, and every event handler.
export const sanitizeHtml = (input: string): string => {
  let html = String(input || '')

  html = html.replace(/<!--[\s\S]*?-->/g, '')
  html = html.replace(/<\s*(script|style|iframe|object|embed|form|input|link|meta|svg|math)[\s\S]*?<\/\s*\1\s*>/gi, '')
  html = html.replace(/<\s*(script|style|iframe|object|embed|form|input|link|meta|img)[^>]*\/?>/gi, '')

  html = html.replace(/<\s*(\/?)\s*([a-zA-Z0-9]+)([^>]*)>/g, (_full, slash: string, rawTag: string, attrs: string) => {
    const tag = rawTag.toLowerCase()
    if (!ALLOWED_TAGS.includes(tag)) return ''
    if (slash) return `</${tag}>`

    if (tag === 'a') {
      const href = attrs.match(/href\s*=\s*"([^"]*)"/i) || attrs.match(/href\s*=\s*'([^']*)'/i)
      const url = href ? href[1].trim() : ''
      if (!/^https?:\/\//i.test(url)) return '<a>'
      return `<a href="${url.replace(/"/g, '&quot;')}" target="_blank" rel="nofollow noopener">`
    }
    return `<${tag}>`
  })

  return html.trim()
}

const wordCount = (html: string): number => stripTags(html).split(/\s+/).filter(Boolean).length

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

// --- DeepSeek ------------------------------------------------------------

export const callDeepSeek = async (
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<any> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120000)

  let res: Response
  try {
    res = await fetch(DEEPSEEK_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 4000,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`DeepSeek responded ${res.status}: ${detail.slice(0, 400)}`)
  }

  const payload = await res.json()
  const raw = payload?.choices?.[0]?.message?.content
  if (!raw) throw new Error('DeepSeek returned no message content')

  // response_format should give us bare JSON, but a stray markdown fence is a
  // cheap thing to survive.
  const cleaned = String(raw).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()

  try {
    return JSON.parse(cleaned)
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start === -1 || end <= start) throw new Error('DeepSeek did not return parseable JSON')
    return JSON.parse(cleaned.slice(start, end + 1))
  }
}

const buildUserPrompt = (angle: Angle, items: FeedItem[]): string => {
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  const material = items
    .map((item, i) => {
      const when = item.timestamp ? new Date(item.timestamp).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'undated'
      return `[${i + 1}] ${item.title}
    outlet: ${item.source}
    published: ${when}
    url: ${item.link}
    summary: ${item.description || '(no summary supplied)'}`
    })
    .join('\n\n')

  return `Today is ${today}.

TODAY'S BRIEF — ${angle.label}
${angle.brief}

SOURCE MATERIAL
Everything below was published by these outlets in the last few days. It is the only factual basis you have. If something is not in here, you do not know it.

${material}

Write the article now. Respond with the JSON object only.`
}

// --- Storage -------------------------------------------------------------

const store = () => getStore({ name: STORE_NAME, consistency: 'strong' })

export const readIndex = async (): Promise<Index> => {
  try {
    const data = (await store().get(INDEX_KEY, { type: 'json' })) as Index | null
    if (!data) return { ...EMPTY_INDEX }
    return {
      updatedAt: data.updatedAt || 0,
      covered: Array.isArray(data.covered) ? data.covered : [],
      articles: Array.isArray(data.articles) ? data.articles : [],
    }
  } catch {
    return { ...EMPTY_INDEX }
  }
}

const writeIndex = async (index: Index): Promise<void> => {
  await store().setJSON(INDEX_KEY, index)
}

// --- Orchestration -------------------------------------------------------

export type RunResult =
  | { status: 'published'; article: StoredArticle; sourcesConsidered: number }
  | { status: 'skipped'; reason: string }

export const runArticleGeneration = async (opts: {
  angleId?: string
  force?: boolean
} = {}): Promise<RunResult> => {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) return { status: 'skipped', reason: 'DEEPSEEK_API_KEY is not set on this site.' }

  const model = process.env.DEEPSEEK_MODEL || DEFAULT_MODEL
  const index = await readIndex()

  // One article per day unless explicitly forced.
  if (!opts.force) {
    const lastToday = index.articles.find(
      (a) => new Date(a.timestamp).toDateString() === new Date().toDateString(),
    )
    if (lastToday) return { status: 'skipped', reason: `Already published "${lastToday.title}" today.` }
  }

  const angle =
    (opts.angleId && ANGLES.find((a) => a.id === opts.angleId)) || angleForDate(new Date())

  const material = await gatherSourceMaterial(angle, index.covered)
  if (material.length < 3) {
    return { status: 'skipped', reason: `Only ${material.length} uncovered stories available — not enough to write from.` }
  }

  const parsed = await callDeepSeek(apiKey, model, UNITED_ROAD_BRAIN, buildUserPrompt(angle, material))

  const title = stripTags(parsed?.title || '').slice(0, 140)
  const bodyHtml = sanitizeHtml(parsed?.bodyHtml || '')

  if (!title) return { status: 'skipped', reason: 'Model returned no usable title.' }
  const words = wordCount(bodyHtml)
  if (words < 180) return { status: 'skipped', reason: `Model returned only ${words} words of body copy.` }

  const standfirst = stripTags(parsed?.standfirst || '').slice(0, 260)
  const tags = Array.isArray(parsed?.tags)
    ? parsed.tags.map((t: unknown) => stripTags(String(t)).toLowerCase().slice(0, 24)).filter(Boolean).slice(0, 5)
    : []

  // Only keep source links that really came from the material we supplied.
  const suppliedLinks = new Set(material.map((m) => m.link))
  const usedLinks: string[] = Array.isArray(parsed?.sourceLinks)
    ? parsed.sourceLinks.filter((l: unknown) => typeof l === 'string' && suppliedLinks.has(l))
    : []
  const sourceItems = (usedLinks.length ? material.filter((m) => usedLinks.includes(m.link)) : material.slice(0, 4))
    .slice(0, 6)
    .map((m) => ({ title: m.title, link: m.link, source: m.source }))

  const now = new Date()
  const article: StoredArticle = {
    id: `ur-${now.toISOString().slice(0, 10)}-${slugify(title) || angle.id}`,
    title,
    standfirst,
    excerpt: standfirst || stripTags(bodyHtml).slice(0, 200),
    content: bodyHtml,
    tags,
    category: stripTags(parsed?.category || angle.label).toUpperCase().slice(0, 24),
    author: 'United Road AI Desk',
    isAI: true,
    angle: angle.id,
    image: material.find((m) => m.thumbnail)?.thumbnail || '',
    date: now.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' }),
    timestamp: now.getTime(),
    readMinutes: Math.max(1, Math.round(words / 220)),
    sources: sourceItems,
    model,
  }

  const nextIndex: Index = {
    updatedAt: now.getTime(),
    covered: [
      ...sourceItems.map((s) => ({ title: s.title, at: now.getTime() })),
      { title, at: now.getTime() },
      ...index.covered,
    ].slice(0, COVERED_MEMORY),
    // Newest first, and cap what we keep so the payload stays small.
    articles: [article, ...index.articles.filter((a) => a.id !== article.id)].slice(0, 120),
  }

  await writeIndex(nextIndex)

  return { status: 'published', article, sourcesConsidered: material.length }
}
