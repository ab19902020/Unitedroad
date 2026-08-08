// The automated United Road article desk.
//
// Once a day (or on demand) this: pulls the same Manchester United feeds the
// site already reads, clusters the day's reporting so one story covered by
// five outlets counts as one story, picks the two or three most significant
// things that have actually happened, and asks DeepSeek to write each one up
// in the United Road house voice (see brain.mts). Output is sanitised and
// stored in Netlify Blobs, where /api/articles serves it to the site.
//
// If there is nothing worth writing about, it writes nothing. That is a
// feature: filler is worse than silence on a fan site.
//
// The DeepSeek key lives only in the DEEPSEEK_API_KEY environment variable and
// is never sent to the browser — every call happens here, on the server.

import { getStore } from '@netlify/blobs'
import { fetchFeed, stripTags, type FeedItem } from './feed.mts'
import { UNITED_ROAD_BRAIN, BATCH, RELATED_CONTEXT_COUNT } from './brain.mts'
import { getWorkerAuth } from './worker-auth.mts'

const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions'
const DEFAULT_MODEL = 'deepseek-v4-flash'
const STORE_NAME = 'united-road-articles'
const INDEX_KEY = 'index.json'

// How many past headlines we keep purely to avoid re-writing the same story.
const COVERED_MEMORY = 120

// Everything the desk publishes goes out under the site owner's byline. There
// is no separate machine byline and nothing on the page says how a piece was
// produced — these are United Road articles, full stop.
const AUTHOR_NAME = 'Adam James'

export type StoredArticle = {
  id: string
  title: string
  standfirst: string
  excerpt: string
  content: string
  tags: string[]
  category: string
  shape: string
  tone: string
  author: string
  isAI: true
  image: string
  date: string
  timestamp: number
  readMinutes: number
  sources: { title: string; link: string; source: string }[]
  model: string
}

/**
 * What happened the last time the desk ran, successfully or not.
 *
 * This exists because a background function is invisible from the outside:
 * Netlify answers 202 the moment it accepts the request, before the handler
 * runs, so the HTTP response says nothing about whether an article was
 * written, the token was wrong, or DeepSeek refused. Recording the outcome
 * here gives /api/desk-status something truthful to report.
 */
export type RunRecord = {
  at: number
  trigger: string
  status: string
  publishedCount: number
  titles: string[]
  storiesAvailable: number
  notes: string[]
  error?: string
  durationMs: number
}

type Index = {
  updatedAt: number
  covered: { title: string; at: number }[]
  articles: StoredArticle[]
  lastRun?: RunRecord
  lastRejectedAt?: number
}

const EMPTY_INDEX: Index = { updatedAt: 0, covered: [], articles: [] }

// --- Sources -------------------------------------------------------------

// Google News search feeds. These are discovery only: their <description> is a
// bare anchor tag with no summary, and their links are google redirects, so
// they cannot be written from. What they are superb at is telling us WHICH
// stories the UK press is running — including everything the reliable transfer
// reporters break — which is exactly the corroboration signal the ranking needs.
const googleNews = (query: string) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-GB&gl=GB&ceid=GB:en`

type FeedDef = {
  url: string
  source: string
  /** Skip the "is this about United?" keyword filter — the whole feed is United. */
  trusted?: boolean
  /** Headlines only: may corroborate a story, may never be the sole basis for one. */
  discovery?: boolean
}

// Publishers we can quote and write from, because their feeds carry real
// article summaries.
const FEEDS: FeedDef[] = [
  { url: 'https://www.manchestereveningnews.co.uk/sport/football/manchester-united-fc/?service=rss', source: 'Manchester Evening News', trusted: true },
  { url: 'https://www.manchestereveningnews.co.uk/sport/football/transfer-news/?service=rss', source: 'Manchester Evening News' },
  { url: 'http://feeds.bbci.co.uk/sport/football/teams/manchester-united/rss.xml', source: 'BBC Sport', trusted: true },
  { url: 'https://www.skysports.com/rss/11065', source: 'Sky Sports' },
  { url: 'https://www.theguardian.com/football/manchester-united/rss', source: 'The Guardian', trusted: true },
  { url: 'https://www.independent.co.uk/sport/football/teams/manchester-united/rss', source: 'The Independent', trusted: true },
  { url: 'https://talksport.com/football/team/manchester-united/feed/', source: 'talkSPORT', trusted: true },
  { url: 'https://www.dailymail.co.uk/sport/teampages/manchester-united.rss', source: 'Daily Mail', trusted: true },
  { url: 'https://www.mirror.co.uk/all-about/manchester-united?service=rss', source: 'The Mirror', trusted: true },
  { url: 'https://www.express.co.uk/posts/rss/istory/manchester-united', source: 'Daily Express', trusted: true },
  { url: 'https://metro.co.uk/tag/manchester-united/feed/', source: 'Metro', trusted: true },
  { url: 'https://ir.manutd.com/rss/news-releases.aspx', source: 'Manchester United (official)', trusted: true },

  // Dedicated United sites — verified live and consistently the fastest movers.
  { url: 'https://thepeoplesperson.com/feed/', source: 'The Peoples Person', trusted: true },
  { url: 'https://strettynews.com/feed/', source: 'Stretty News', trusted: true },
  { url: 'https://unitedinfocus.com/feed/', source: 'United In Focus', trusted: true },
  { url: 'https://utddistrict.co.uk/feed/', source: 'Utd District', trusted: true },
  { url: 'https://thebusbybabe.sbnation.com/rss/index.xml', source: 'The Busby Babe', trusted: true },

  // General football sites — keyword filtered, since most of their output is
  // about other clubs.
  { url: 'https://www.caughtoffside.com/tag/manchester-united/feed/', source: 'CaughtOffside' },
  { url: 'https://www.teamtalk.com/manchester-united/feed', source: 'TEAMtalk' },
  { url: 'https://www.footballinsider247.com/manchester-united/feed/', source: 'Football Insider' },
  { url: 'https://www.90min.com/posts.rss', source: '90min' },

  // Discovery: what the whole UK press is running right now, including the
  // reporters worth trusting on transfers.
  { url: googleNews('Manchester United'), source: 'Google News', discovery: true },
  { url: googleNews('Manchester United transfer'), source: 'Google News', discovery: true },
  { url: googleNews('Fabrizio Romano Manchester United'), source: 'Google News', discovery: true },
  { url: googleNews('David Ornstein Manchester United'), source: 'Google News', discovery: true },
  { url: googleNews('Manchester United injury team news'), source: 'Google News', discovery: true },
]

const UNITED_TERMS = [
  'manchester united', 'man utd', 'man united', 'mufc', 'old trafford',
  'red devils', 'carrington', 'stretford', 'united',
]

// Headlines that are never worth an article, however recent.
const JUNK_PATTERNS = [
  /^(live|live:)/i,
  /\b(quiz|caption contest|predict the score|team news quiz)\b/i,
  /\b(betting|odds|bet365|free bets|casino)\b/i,
  /^(watch|listen):/i,
]

const FOUR_DAYS = 4 * 24 * 60 * 60 * 1000

const isAboutUnited = (item: FeedItem, trusted: boolean): boolean => {
  if (trusted) return true
  const text = `${item.title} ${item.description}`.toLowerCase()
  return UNITED_TERMS.some((t) => text.includes(t))
}

// Trim a headline to a comparable core, so "United close on X" and "Man Utd
// close in on X" are recognised as the same story.
const normaliseTitle = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(man utd|man united|manchester united|mufc|united|the|a|an|of|for|to|on|in|as|is|it|and|but|with|from|at|by)\b/g, ' ')
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

/** A feed item plus where it came from. */
type SourceItem = FeedItem & { discovery?: boolean }

/** One real-world story, as reported by one or more outlets. */
export type StoryCluster = {
  lead: SourceItem
  /** Only items with real summaries — these are what the article is written from. */
  members: SourceItem[]
  /** Every outlet running this story, including discovery-only sightings. */
  outlets: string[]
  timestamp: number
}

// Google News titles arrive as "Headline text - Outlet Name". Splitting the
// outlet off gives both a clean headline for clustering and the name of the
// publication actually running the story, which is a better corroboration
// signal than counting "Google News" five times.
const splitGoogleTitle = (title: string): { title: string; outlet: string | null } => {
  const idx = title.lastIndexOf(' - ')
  if (idx < 20) return { title, outlet: null }
  const outlet = title.slice(idx + 3).trim()
  // A real outlet name is short; anything long is part of the headline.
  if (!outlet || outlet.length > 40 || outlet.includes(' - ')) return { title, outlet: null }
  return { title: title.slice(0, idx).trim(), outlet }
}

// Fetch everything, throw away what is not about United, then group what is
// left by story rather than by article. A transfer covered by five outlets is
// one story worth writing about, not five.
export const gatherStories = async (covered: Index['covered']): Promise<StoryCluster[]> => {
  const results = await Promise.all(
    FEEDS.map(async (f) => {
      const items = await fetchFeed(f.url, f.source)
      return items
        .filter((i) => i.title && i.link)
        .map((i): SourceItem => {
          if (!f.discovery) return { ...i, source: f.source }
          const { title, outlet } = splitGoogleTitle(i.title)
          return { ...i, title, source: outlet || f.source, description: '', discovery: true }
        })
        .filter((i) => !JUNK_PATTERNS.some((p) => p.test(i.title)))
        // Discovery queries are already United-scoped, so trust them.
        .filter((i) => isAboutUnited(i, !!f.trusted || !!f.discovery))
    }),
  )

  const cutoff = Date.now() - FOUR_DAYS
  const byLink = new Map<string, SourceItem>()
  results
    .flat()
    .filter((i) => !i.timestamp || i.timestamp >= cutoff)
    .forEach((i) => { if (!byLink.has(i.link)) byLink.set(i.link, i) })

  // Writable items first, so a cluster's lead is always something we can
  // actually write from rather than a headline-only sighting.
  const items = [...byLink.values()].sort(
    (a, b) => Number(!!a.discovery) - Number(!!b.discovery) || b.timestamp - a.timestamp,
  )

  // Cluster by headline similarity.
  const clusters: StoryCluster[] = []
  for (const item of items) {
    const key = normaliseTitle(item.title)
    const existing = clusters.find((c) => overlapRatio(normaliseTitle(c.lead.title), key) > 0.6)
    if (existing) {
      // Discovery items count toward corroboration but are never written from.
      if (!item.discovery) existing.members.push(item)
      if (!existing.outlets.includes(item.source)) existing.outlets.push(item.source)
      existing.timestamp = Math.max(existing.timestamp, item.timestamp)
    } else {
      clusters.push({
        lead: item,
        members: item.discovery ? [] : [item],
        outlets: [item.source],
        timestamp: item.timestamp,
      })
    }
  }

  // Drop stories the desk has already published about, and any cluster that
  // exists only as headlines — there is nothing to write from, and inventing
  // the body is exactly what the factual rules forbid.
  const fresh = clusters
    .filter((c) => c.members.length > 0)
    .filter((c) => !covered.some((prev) => overlapRatio(normaliseTitle(prev.title), normaliseTitle(c.lead.title)) > 0.55))

  // Significance: corroboration first (more outlets carrying it means it
  // matters more), then how much has been written, then recency.
  fresh.sort(
    (a, b) =>
      b.outlets.length - a.outlets.length ||
      b.members.length - a.members.length ||
      b.timestamp - a.timestamp,
  )

  return fresh
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

// Guard against the model lifting a sentence straight from a source.
//
// The window length matters more than it looks. Measured against a genuinely
// rewritten article: at 6 words there were 11 "matches", at 8 there were 2 —
// all of them unavoidable factual phrasing ("on last year's third place
// finish"), none of them copying. At 10 and above, zero. So 12 is the length
// at which a shared run is real evidence of lifting rather than two writers
// stating the same fact in the only sensible order.
const VERBATIM_WINDOW = 12

const sharedRuns = (a: string, b: string): string[] => {
  const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)
  const wa = words(a)
  const wb = words(b)
  if (wa.length < VERBATIM_WINDOW || wb.length < VERBATIM_WINDOW) return []

  const seen = new Set<string>()
  for (let i = 0; i + VERBATIM_WINDOW <= wb.length; i++) {
    seen.add(wb.slice(i, i + VERBATIM_WINDOW).join(' '))
  }

  const hits: string[] = []
  for (let i = 0; i + VERBATIM_WINDOW <= wa.length; i++) {
    const run = wa.slice(i, i + VERBATIM_WINDOW).join(' ')
    if (seen.has(run)) hits.push(run)
  }
  return hits
}

// Collapse overlapping windows into a handful of representative phrases, so a
// correction prompt shows the writer the problem rather than 40 near-copies of
// the same sentence.
const distinctRuns = (runs: string[], limit = 4): string[] => {
  const kept: string[] = []
  for (const run of runs) {
    if (kept.some((k) => k.includes(run.slice(0, 40)) || run.includes(k.slice(0, 40)))) continue
    kept.push(run)
    if (kept.length >= limit) break
  }
  return kept
}

// --- DeepSeek ------------------------------------------------------------

export const callDeepSeek = async (
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<any> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180000)

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
        // Thinking is off deliberately.
        //
        // Reasoning tokens are billed and budgeted as output tokens, and even
        // at reasoning_effort "low" this prompt was observed spending the
        // entire 12k allowance thinking and returning an empty message — a
        // failure that costs money and produces nothing, which is disqualifying
        // for an unattended daily job. Measured side by side on the same story:
        // disabled took 6.5s with 0 reasoning tokens, low took 17.5s with 753,
        // and real runs with reasoning on ranged from 46s to 99s per article.
        // The task is "restate supplied facts in a fixed voice" — it does not
        // need chain of thought, and the article quality is indistinguishable.
        thinking: { type: 'disabled' },
        // Comfortably above a 650-word article plus JSON overhead, and with
        // thinking off there is nothing that can run away with it.
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
  const choice = payload?.choices?.[0]
  const raw = choice?.message?.content

  if (!raw) {
    // The most likely cause is the response being cut off at max_tokens, which
    // is worth naming explicitly rather than reporting as a generic empty reply.
    const reason = choice?.finish_reason || 'unknown'
    const reasoningTokens = payload?.usage?.completion_tokens_details?.reasoning_tokens ?? 0
    throw new Error(
      `DeepSeek returned no message content (finish_reason=${reason}, reasoning_tokens=${reasoningTokens})`,
    )
  }

  // response_format should give bare JSON, but a stray markdown fence is a
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

const describeItem = (item: FeedItem, n: number): string => {
  const when = item.timestamp
    ? `${new Date(item.timestamp).toISOString().slice(0, 16).replace('T', ' ')} UTC`
    : 'undated'
  return `[${n}] ${item.title}
    outlet: ${item.source}
    published: ${when}
    url: ${item.link}
    report: ${item.description || '(no summary supplied)'}`
}

const buildUserPrompt = (
  story: StoryCluster,
  otherStories: StoryCluster[],
  alreadyWritten: string[],
  correction = '',
): string => {
  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })

  // Every account of the same story, so the piece can be written from the
  // reporting as a whole rather than paraphrasing a single article.
  const primary = story.members.slice(0, 6).map((m, i) => describeItem(m, i + 1)).join('\n\n')

  const context = otherStories
    .slice(0, RELATED_CONTEXT_COUNT)
    .map((c, i) => `- ${c.lead.title} (${c.lead.source})`)
    .join('\n')

  const avoid = alreadyWritten.length
    ? `\nALREADY PUBLISHED TODAY — do not write about these again, and do not overlap with them:\n${alreadyWritten.map((t) => `- ${t}`).join('\n')}\n`
    : ''

  return `Today is ${today}.

THE STORY YOU ARE WRITING ABOUT
${story.outlets.length > 1
      ? `This is being reported by ${story.outlets.length} outlets (${story.outlets.join(', ')}), which tells you it matters. You have each account below — read them all, then write it in your own words.`
      : `This is being reported by ${story.lead.source}.`}

${primary}
${context ? `\nOTHER UNITED STORIES TODAY (background only — do not write about these, you may reference one in passing if it is genuinely relevant)\n${context}\n` : ''}${avoid}
Everything above is the only factual basis you have. If something is not in there, you do not know it.
${correction}
Choose the shape that fits this story, judge whether it is good news, bad news or a rumour worth being sceptical about, and write it in the United Road house voice. Respond with the JSON object only.`
}

const buildCorrection = (phrases: string[]): string => `
YOUR PREVIOUS ATTEMPT WAS REJECTED FOR COPYING.
These runs of words appeared in your draft and in the source material, word for word:
${phrases.map((p) => `  • "${p}"`).join('\n')}

That means you were following the source's sentences instead of writing your own. Start again from a blank page. Do not open where the source opens. Put the facts in a different order. Build the piece around your own angle on it, not around their paragraph structure. Keep only proper nouns and figures.
`

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
      lastRun: data.lastRun,
      lastRejectedAt: data.lastRejectedAt,
    }
  } catch {
    return { ...EMPTY_INDEX }
  }
}

const writeIndex = async (index: Index): Promise<void> => {
  await store().setJSON(INDEX_KEY, index)
}

/**
 * Record the outcome of a run without touching the articles. Called for every
 * run including failures, so /api/desk-status can always say what happened
 * last rather than leaving the owner to read function logs.
 */
export const recordRun = async (record: RunRecord): Promise<void> => {
  try {
    const index = await readIndex()
    await writeIndex({ ...index, lastRun: record })
  } catch {
    // Losing the diagnostic record must never fail the run itself.
  }
}

/** Note that someone called the worker with a bad or missing token. */
export const recordRejection = async (): Promise<void> => {
  try {
    const index = await readIndex()
    await writeIndex({ ...index, lastRejectedAt: Date.now() })
  } catch {
    // Best effort only.
  }
}

/** Everything /api/desk-status needs, with no secrets in it. */
export const readStatus = async (contextSiteId?: string) => {
  const index = await readIndex()
  const auth = getWorkerAuth(contextSiteId)
  return {
    deepseekKeySet: !!process.env.DEEPSEEK_API_KEY,
    writerTokenSet: !!process.env.ARTICLE_WRITER_TOKEN,
    authMode: auth.mode,
    model: process.env.DEEPSEEK_MODEL || DEFAULT_MODEL,
    articleCount: index.articles.length,
    latestArticle: index.articles[0]
      ? { title: index.articles[0].title, at: index.articles[0].timestamp }
      : null,
    lastRun: index.lastRun || null,
    lastRejectedAt: index.lastRejectedAt || null,
  }
}

// --- Writing one article -------------------------------------------------

type WriteOutcome =
  | { ok: true; article: StoredArticle; calls: number }
  | { ok: false; reason: string; calls: number }

// Write one article, with a single corrective retry if the first draft came
// back following the source's sentences. Showing the model the exact phrases it
// lifted works far better than abandoning the story and paying for a fresh one
// on a different subject.
const writeOne = async (
  apiKey: string,
  model: string,
  story: StoryCluster,
  otherStories: StoryCluster[],
  alreadyWritten: string[],
): Promise<WriteOutcome> => {
  let correction = ''
  let calls = 0
  let lastReason = 'unknown'

  for (let attempt = 0; attempt < 2; attempt++) {
    calls++
    const parsed = await callDeepSeek(
      apiKey,
      model,
      UNITED_ROAD_BRAIN,
      buildUserPrompt(story, otherStories, alreadyWritten, correction),
    )

    const result = validate(parsed, story, model)
    if (result.ok) return { ...result, calls }

    lastReason = result.reason
    if (!result.copiedPhrases?.length) break
    correction = buildCorrection(result.copiedPhrases)
  }

  return { ok: false, reason: lastReason, calls }
}

type ValidateResult =
  | { ok: true; article: StoredArticle }
  | { ok: false; reason: string; copiedPhrases?: string[] }

const validate = (parsed: any, story: StoryCluster, model: string): ValidateResult => {
  const title = stripTags(parsed?.title || '').slice(0, 160)
  const bodyHtml = sanitizeHtml(parsed?.bodyHtml || '')

  if (!title) return { ok: false, reason: 'no usable title' }

  const words = wordCount(bodyHtml)
  if (words < 220) return { ok: false, reason: `only ${words} words of body copy` }

  // Refuse anything that has lifted whole sentences from a source.
  const bodyText = stripTags(bodyHtml)
  const runs = story.members.flatMap((m) => sharedRuns(bodyText, m.description))
  if (runs.length) {
    return {
      ok: false,
      reason: `reproduced ${runs.length} run(s) of source phrasing verbatim`,
      copiedPhrases: distinctRuns(runs),
    }
  }

  const standfirst = stripTags(parsed?.standfirst || '').slice(0, 260)
  const tags = Array.isArray(parsed?.tags)
    ? parsed.tags.map((t: unknown) => stripTags(String(t)).toLowerCase().slice(0, 24)).filter(Boolean).slice(0, 5)
    : []

  // Only keep source links that really came from the material we supplied.
  const supplied = new Map(story.members.map((m) => [m.link, m]))
  const claimed: string[] = Array.isArray(parsed?.sourceLinks)
    ? parsed.sourceLinks.filter((l: unknown) => typeof l === 'string' && supplied.has(l as string))
    : []
  const sourceItems = (claimed.length ? claimed.map((l) => supplied.get(l)!) : story.members)
    .slice(0, 6)
    .map((m) => ({ title: m.title, link: m.link, source: m.source }))

  const now = new Date()
  return {
    ok: true,
    article: {
      id: `ur-${now.toISOString().slice(0, 10)}-${slugify(title) || 'united-road'}`,
      title,
      standfirst,
      excerpt: standfirst || stripTags(bodyHtml).slice(0, 200),
      content: bodyHtml,
      tags,
      category: stripTags(parsed?.category || 'NEWS').toUpperCase().slice(0, 24),
      shape: stripTags(parsed?.shape || '').toUpperCase().slice(0, 12),
      tone: stripTags(parsed?.tone || '').toLowerCase().slice(0, 12),
      author: AUTHOR_NAME,
      isAI: true,
      image: story.members.find((m) => m.thumbnail)?.thumbnail || '',
      date: now.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' }),
      timestamp: now.getTime(),
      readMinutes: Math.max(1, Math.round(words / 220)),
      sources: sourceItems,
      model,
    },
  }
}

// --- Orchestration -------------------------------------------------------

export type BatchResult = {
  status: 'published' | 'nothing-to-write' | 'skipped'
  published: StoredArticle[]
  storiesAvailable: number
  notes: string[]
}

export const runDailyBatch = async (opts: {
  max?: number
  force?: boolean
} = {}): Promise<BatchResult> => {
  const notes: string[] = []
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    return { status: 'skipped', published: [], storiesAvailable: 0, notes: ['DEEPSEEK_API_KEY is not set on this site.'] }
  }

  const model = process.env.DEEPSEEK_MODEL || DEFAULT_MODEL
  const index = await readIndex()

  const today = new Date().toDateString()
  const publishedToday = index.articles.filter((a) => new Date(a.timestamp).toDateString() === today)

  const ceiling = Math.max(1, Math.min(opts.max ?? BATCH.maxArticles, BATCH.maxArticles))
  const remaining = opts.force ? ceiling : Math.max(0, ceiling - publishedToday.length)

  if (remaining === 0) {
    return {
      status: 'skipped',
      published: [],
      storiesAvailable: 0,
      notes: [`Already published ${publishedToday.length} article(s) today.`],
    }
  }

  const stories = await gatherStories(index.covered)

  if (stories.length === 0) {
    return { status: 'nothing-to-write', published: [], storiesAvailable: 0, notes: ['No uncovered United stories in the feeds.'] }
  }

  // Scale the run to the day. A quiet day gets one piece, or none — the desk
  // is not obliged to fill a quota.
  const target = Math.min(remaining, Math.max(1, Math.floor(stories.length / BATCH.storiesPerArticle)))
  notes.push(`${stories.length} uncovered stories available, writing up to ${target}.`)

  const published: StoredArticle[] = []
  const writtenTitles = publishedToday.map((a) => a.title)
  const coveredNow = [...index.covered]

  // Every generation is a paid API call, so a run that keeps rejecting output
  // must not walk the whole story list. Budget in calls rather than stories,
  // since one story can cost two calls when the first draft is caught copying.
  // The worker also has a 15 minute ceiling to stay under.
  const callBudget = target * 2 + 2
  let callsUsed = 0

  for (let i = 0; i < stories.length && published.length < target && callsUsed < callBudget; i++) {
    const story = stories[i]
    const others = stories.filter((_, n) => n !== i)

    try {
      const outcome = await writeOne(apiKey, model, story, others, writtenTitles)
      callsUsed += outcome.calls
      if (!outcome.ok) {
        notes.push(`Skipped "${story.lead.title.slice(0, 60)}": ${outcome.reason}.`)
        continue
      }
      // A repeat headline within the same run means the model drifted onto a
      // story it has already done; drop it rather than publish a near-duplicate.
      if (published.some((p) => overlapRatio(normaliseTitle(p.title), normaliseTitle(outcome.article.title)) > 0.6)) {
        notes.push(`Skipped "${outcome.article.title.slice(0, 60)}": duplicates an article from this run.`)
        continue
      }

      published.push(outcome.article)
      writtenTitles.push(outcome.article.title)
      coveredNow.unshift(
        { title: outcome.article.title, at: Date.now() },
        ...story.members.map((m) => ({ title: m.title, at: Date.now() })),
      )
    } catch (err) {
      // One bad generation must not take the rest of the batch down.
      callsUsed++
      notes.push(`Failed on "${story.lead.title.slice(0, 60)}": ${(err as Error).message}`)
    }
  }

  if (callsUsed >= callBudget && published.length < target) {
    notes.push(`Stopped after ${callsUsed} API calls to protect the budget.`)
  }

  if (published.length === 0) {
    return { status: 'nothing-to-write', published: [], storiesAvailable: stories.length, notes }
  }

  await writeIndex({
    updatedAt: Date.now(),
    covered: coveredNow.slice(0, COVERED_MEMORY),
    articles: [
      ...published,
      ...index.articles.filter((a) => !published.some((p) => p.id === a.id)),
    ].slice(0, 200),
  })

  return { status: 'published', published, storiesAvailable: stories.length, notes }
}
