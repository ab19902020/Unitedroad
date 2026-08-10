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
import { UNITED_ROAD_BRAIN, NEWS_MODE_BRIEF, ARTICLE_MODE_BRIEF, MATCH_MODE_BRIEF, WEEKLY_MODE_BRIEF, ANTI_TEMPLATE, buildVarietyNote, buildArchiveNote, BATCH, RELATED_CONTEXT_COUNT, type ArticleKind } from './brain.mts'
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

// Bylines used before the change, rewritten to AUTHOR_NAME whenever a stored
// article is read back.
const LEGACY_BYLINES = new Set(['United Road AI Desk', 'United Road Editorial'])

export type StoredArticle = {
  id: string
  title: string
  standfirst: string
  excerpt: string
  content: string
  tags: string[]
  /** People the piece is genuinely about, for the /player topic pages. */
  people?: string[]
  /** Photographer credit, required when the cover came from Wikimedia Commons. */
  imageCredit?: string
  /** Ids of our own earlier pieces a reader would want next. */
  relatedIds?: string[]
  /** Alternative headlines the writer produced, kept for review. */
  titleOptions?: string[]
  category: string
  shape: string
  tone: string
  kind: ArticleKind
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

/**
 * A story the desk judged worth covering but had no quota left to write.
 *
 * This exists because the old behaviour was to drop it. Once the day's ceiling
 * was reached, anything that did not clear the significance bar in that exact
 * five-minute window was gone — not deferred, gone — and the next run started
 * from the feeds again with no memory that it had ever seen the story. A signing
 * confirmed at nine in the evening simply never got written.
 *
 * Nothing is discarded now. A story we cannot write is remembered, its
 * significance carried with it, and it takes priority the moment there is room
 * — including first thing the next morning when the quota resets.
 */
type PendingStory = {
  /** Normalised lead title; the same key sameStory() matches on. */
  key: string
  title: string
  firstSeen: number
  lastSeen: number
  /** Highest outlet count seen while it has been waiting. */
  outlets: number
  /** 0-10 significance from triage; -1 until it has been scored. */
  score: number
  /** How many runs have passed it over, so a story cannot starve forever. */
  waits: number
}

type Index = {
  updatedAt: number
  covered: { title: string; at: number }[]
  articles: StoredArticle[]
  pending?: PendingStory[]
  lastRun?: RunRecord
  lastRejectedAt?: number
}

const EMPTY_INDEX: Index = { updatedAt: 0, covered: [], articles: [], pending: [] }

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
  { url: 'https://www.football.london/all-about/manchester-united?service=rss', source: 'football.london' },
  { url: 'https://www.givemesport.com/feed/', source: 'GiveMeSport' },
  { url: 'https://www.footballfancast.com/feed', source: 'Football FanCast' },
  { url: 'https://theathletic.com/rss/team/manchester-united/', source: 'The Athletic' },
  { url: 'https://www.tribalfootball.com/rss/manchester-united', source: 'Tribal Football' },
  { url: 'https://www.sportsmole.co.uk/football/man-utd/rss.xml', source: 'Sports Mole' },
  { url: 'https://www.hitc.com/en-gb/category/football/feed/', source: 'HITC' },
  { url: 'https://readmanutd.com/feed/', source: 'Read Man Utd' },
  { url: 'https://www.manchestereveningnews.co.uk/sport/football/?service=rss', source: 'MEN Football' },
  { url: 'https://www.reddit.com/r/reddevils/hot.rss', source: 'r/reddevils' },

  // Discovery: what the whole UK press is running right now, including the
  // reporters worth trusting on transfers.
  { url: googleNews('Manchester United'), source: 'Google News', discovery: true },
  { url: googleNews('Manchester United transfer'), source: 'Google News', discovery: true },
  { url: googleNews('Fabrizio Romano Manchester United'), source: 'Google News', discovery: true },
  { url: googleNews('David Ornstein Manchester United'), source: 'Google News', discovery: true },
  { url: googleNews('Manchester United injury team news'), source: 'Google News', discovery: true },
  { url: googleNews('Manchester United Carrick'), source: 'Google News', discovery: true },
  { url: googleNews('Manchester United signing agreement medical'), source: 'Google News', discovery: true },
  { url: googleNews('"Man Utd" OR "Manchester United" academy youth'), source: 'Google News', discovery: true },
  { url: googleNews('Manchester United Old Trafford Ineos Ratcliffe'), source: 'Google News', discovery: true },
  // The reporters whose word actually settles a story. Discovery only — used to
  // spot which lines are real and which outlets are running them, never quoted
  // or named in the copy.
  { url: googleNews('Laurie Whitwell Manchester United'), source: 'Google News', discovery: true },
  { url: googleNews('Simon Stone Manchester United'), source: 'Google News', discovery: true },
  { url: googleNews('James Ducker OR "Mike McGrath" Manchester United'), source: 'Google News', discovery: true },
  { url: googleNews('Rob Dawson OR "Mark Critchley" Manchester United'), source: 'Google News', discovery: true },
  { url: googleNews('"Charlotte Duncker" OR "Andy Mitten" OR "Simon Peach" Manchester United'), source: 'Google News', discovery: true },
]

// Terms that identify a story as being about *this* club.
//
// A bare "united" is deliberately absent: it matches Newcastle United, Leeds
// United, West Ham United and a dozen others, which is how stories about other
// clubs ended up on the site. Every term here is unambiguous.
const UNITED_TERMS = [
  'manchester united', 'man utd', 'man united', 'manchester utd', 'mufc',
  'old trafford', 'red devils', 'carrington', 'stretford end',
  'united\u2019s squad', 'the theatre of dreams',
]

// Rival clubs. A story is rejected outright if it names one of these and never
// names United, even if some other keyword matched.
const RIVAL_CLUBS = [
  'liverpool', 'arsenal', 'chelsea', 'tottenham', 'spurs', 'manchester city',
  'man city', 'newcastle united', 'everton', 'aston villa', 'west ham',
  'leeds united', 'real madrid', 'barcelona', 'bayern', 'psg', 'juventus',
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
  const title = (item.title || '').toLowerCase()
  const text = `${item.title} ${item.description}`.toLowerCase()
  const namesUnited = UNITED_TERMS.some((t) => text.includes(t))
  const titleNamesUnited = UNITED_TERMS.some((t) => title.includes(t))

  if (!namesUnited) return false

  // Dedicated United feeds are allowed to rely on the body: their headlines
  // often say "the Reds" or just a player's name.
  if (trusted) return true

  // General feeds (Sky's Premier League wire, 90min, GiveMeSport) must name
  // United in the HEADLINE. A passing mention in the body is how a Roy Keane
  // punditry package or an Alisson interview ends up on a United site.
  if (!titleNamesUnited) return false

  // And even then, not if the headline leads with a rival.
  if (RIVAL_CLUBS.some((c) => title.includes(c)) && title.indexOf(UNITED_TERMS.find((t) => title.includes(t)) || '') > 0) {
    const firstUnited = Math.min(...UNITED_TERMS.filter((t) => title.includes(t)).map((t) => title.indexOf(t)))
    const firstRival = Math.min(...RIVAL_CLUBS.filter((c) => title.includes(c)).map((c) => title.indexOf(c)))
    if (firstRival < firstUnited) return false
  }

  return true
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

// Words that name this club, or are too common in football headlines to say
// anything about which story we are looking at.
const GENERIC_ENTITIES = new Set([
  'man', 'manchester', 'united', 'utd', 'mufc', 'reds', 'devils', 'old', 'trafford',
  'carrington', 'premier', 'league', 'the', 'and', 'for', 'with', 'from', 'his', 'her',
  'why', 'how', 'what', 'who', 'when', 'new', 'set', 'transfer', 'news', 'club', 'boss',
  'star', 'ace', 'deal', 'move', 'report', 'reports', 'exclusive', 'official', 'live',
  // Calendar and stock headline furniture — these repeat constantly and say
  // nothing about which story we are looking at.
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september',
  'october', 'november', 'december', 'today', 'tonight', 'season', 'pre', 'watch',
  'details', 'update', 'updates', 'latest', 'expect', 'explained', 'fans', 'squad',
  'first', 'next', 'back', 'out', 'top', 'best', 'full', 'here', 'still', 'could',
  'will', 'would', 'says', 'said', 'after', 'before', 'over', 'into', 'more',
  // Competition and match furniture. "World" and "Cup" in particular appear in
  // dozens of unrelated headlines during a tournament year, and merging on them
  // fused four separate stories into one. A competition with a distinctive name
  // still clusters on that name — Snapdragon, Carabao, Champions.
  'world', 'cup', 'final', 'semi', 'friendly', 'debut', 'clash', 'tie', 'game',
  'match', 'win', 'beat', 'loss', 'draw', 'goal', 'goals', 'team', 'side', 'xi',
])

// Clubs and competitions the press names two ways. Without this, "Man United
// vs Paris Saint-Germain" and "How to Watch PSG vs Man United" look like
// different fixtures.
const ENTITY_ALIASES: Record<string, string> = {
  paris: 'psg', germain: 'psg', 'saint-germain': 'psg', psg: 'psg',
  spurs: 'tottenham', tottenham: 'tottenham',
  city: 'mancity', 'man-city': 'mancity',
  wolves: 'wolverhampton', wolverhampton: 'wolverhampton',
  atleti: 'atletico', atletico: 'atletico',
  inter: 'internazionale', internazionale: 'internazionale',
  ucl: 'championsleague', champions: 'championsleague',
  epl: 'premierleague',
  utd: 'united',
}

const canonicalEntity = (w: string): string => ENTITY_ALIASES[w] || w

// Proper nouns and other distinctive tokens in a headline: the player, the
// selling club, the competition, the ground. These are what actually identify a
// story, which headline word-overlap does not — "How to Watch PSG vs Man United"
// and "Tielemans Set for Debut in PSG Friendly" share no long words at all, yet
// both are about the same fixture.
const entitiesOf = (title: string): Set<string> => {
  const out = new Set<string>()
  const words = String(title || '').split(/[^A-Za-z0-9'\u2019-]+/).filter(Boolean)
  words.forEach((raw, i) => {
    const w = raw.replace(/['\u2019].*$/, '')
    if (w.length < 3) return
    const lower = w.toLowerCase()
    if (GENERIC_ENTITIES.has(lower)) return
    // Capitalised (but not merely sentence-initial), or an all-caps acronym.
    const isCaps = /^[A-Z]/.test(w)
    const isAcronym = /^[A-Z0-9]{2,}$/.test(w)
    if (isAcronym || (isCaps && i > 0)) out.add(canonicalEntity(lower))
  })
  return out
}

/**
 * Build a "are these the same story?" predicate for a given day's headlines.
 *
 * Word overlap alone is not enough. "How to Watch PSG vs Man United" and
 * "Tielemans Set for Debut in PSG Friendly" share no word longer than three
 * characters once the club name is stripped, yet both are about one fixture —
 * which is how a single friendly produced three separate pieces.
 *
 * So entities decide it. Document frequency is computed across the corpus: an
 * entity carried by only a handful of headlines is distinctive enough that two
 * sharing it are almost certainly about the same thing, while one carried by
 * dozens (a player simply in the news a lot) is not, and needs broad agreement
 * across the rest of the entities before the two are merged.
 *
 * Exported so the behaviour can be tested against real headlines.
 */
export const makeSameStory = (corpus: string[]) => {
  const cache = new Map<string, Set<string>>()
  const entitiesFor = (title: string) => {
    let e = cache.get(title)
    if (!e) { e = entitiesOf(title); cache.set(title, e) }
    return e
  }

  return (a: string, b: string): boolean => {
    if (overlapRatio(normaliseTitle(a), normaliseTitle(b)) > 0.6) return true
    const ea = entitiesFor(a)
    const eb = entitiesFor(b)
    if (!ea.size || !eb.size) return false
    // One shared proper noun is enough. Generic football and calendar words are
    // already excluded, so what remains is a player, a club, a competition or a
    // venue — and two United headlines on the same day naming the same one are
    // almost always the same story from two angles.
    //
    // Merging too eagerly is the safer error here: an over-merge costs one
    // alternative angle, while an under-merge puts three pieces about one
    // friendly on the front page, which is what happened.
    return [...ea].some((e) => eb.has(e))
  }
}

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

  const sameStory = makeSameStory(items.map((i) => i.title))

  // Cluster by headline similarity and shared entities.
  const clusters: StoryCluster[] = []
  for (const item of items) {
    const existing = clusters.find((c) => sameStory(c.lead.title, item.title))
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

  // Same test against what has already been published, so a follow-up angle on
  // a story we covered this morning is recognised as the same story.
  // Drop stories the desk has already published about, and any cluster that
  // exists only as headlines — there is nothing to write from, and inventing
  // the body is exactly what the factual rules forbid.
  const fresh = clusters
    .filter((c) => c.members.length > 0)
    .filter((c) => !covered.some((prev) => sameStory(prev.title, c.lead.title)))

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

// Pull the best available picture for a story.
//
// Feed <enclosure>/<media:thumbnail> tags are the cheap path, but plenty of
// publishers omit them, which is why so many stories fell back to generated
// crest art. When none of the reports carry one, fetch the lead article and
// read its og:image — that is the picture the publisher chose for social
// sharing, so it is always the right one for the story.
const BAD_IMAGE = /(logo|placeholder|default|blank|1x1|spacer|avatar|sprite)/i

const usableImage = (url: string | undefined): boolean =>
  !!url && /^https?:\/\//i.test(url) && !BAD_IMAGE.test(url)

const scrapeOgImage = async (pageUrl: string): Promise<string> => {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 6000)
    const res = await fetch(pageUrl, {
      headers: { 'User-Agent': 'UnitedRoadFeedBot/1.0 (+https://unitedroad.uk)' },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer))
    if (!res.ok) return ''
    // The head is all we need; no point pulling a whole article down.
    const html = (await res.text()).slice(0, 60000)
    for (const re of [
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    ]) {
      const m = html.match(re)
      if (m && usableImage(m[1])) return m[1]
    }
  } catch { /* an image is a nice-to-have, never a failure */ }
  return ''
}

/**
 * A free-licensed photograph of a named person from Wikimedia Commons.
 *
 * This exists because the alternative was a generated placeholder. DeepSeek
 * cannot help here — it is a text model, and asked for an image URL it returns
 * a plausible one that 404s — so the answer is a real image source rather than
 * a cleverer prompt.
 *
 * Commons is the right source for a site that wants to keep its photographs:
 * the licences are CC BY / CC BY-SA, which permit commercial reuse provided the
 * photographer is credited, so the credit is fetched with the image and stored
 * beside it. Files are matched on the surname appearing in the filename, which
 * is what separates a portrait of the player from a wide shot of a team he
 * happened to be standing in.
 */
export type CommonsImage = { url: string; credit: string; licence: string }

const COMMONS_ENDPOINT = 'https://commons.wikimedia.org/w/api.php'

export const findCommonsImage = async (
  name: string,
  taken: Set<string> = new Set(),
): Promise<CommonsImage | null> => {
  const clean = name.trim().replace(/\s+/g, ' ')
  const parts = clean.toLowerCase().split(' ')
  const surname = parts[parts.length - 1] || ''
  const forename = parts[0] || ''
  if (surname.length < 3) return null

  const params = new URLSearchParams({
    action: 'query', generator: 'search',
    gsrsearch: clean, gsrnamespace: '6', gsrlimit: '30',
    prop: 'imageinfo', iiprop: 'url|extmetadata|size', iiurlwidth: '1200',
    format: 'json', formatversion: '2',
  })

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 9000)
    const res = await fetch(`${COMMONS_ENDPOINT}?${params}`, {
      headers: { 'User-Agent': 'UnitedRoadBot/1.0 (https://unitedroad.uk)' },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer))
    if (!res.ok) return null

    const data = await res.json()
    const pages: any[] = data?.query?.pages || []
    const thisYear = new Date().getFullYear()

    const scored = pages
      .map((pg) => {
        const ii = pg?.imageinfo?.[0]
        if (!ii?.thumburl) return null

        // Filename with separators flattened, so "David_Beckham_2024.jpg" and
        // "David Beckham (cropped).jpg" are compared the same way.
        const file = String(pg.title || '').replace(/^File:/i, '').replace(/\.[a-z0-9]+$/i, '')
        const flat = file.toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ')

        // The filename must BEGIN with the person's full name.
        //
        // Matching the surname anywhere put Victoria Beckham on a story about
        // David Beckham. Requiring the full name anywhere was still not enough:
        // it returned "Adidas Predator Touch 96 (David Beckham)" — a photograph
        // of a boot — and "Amir Murillo Marcus Rashford England v Panama", two
        // players wrestling. In both the person is incidental to the subject.
        //
        // How Commons is actually named settles it. A photograph *of* someone is
        // filed under their name first — "Michael Carrick 12042025", "Kobbie
        // Mainoo England v Ghana". When the name appears later or in brackets,
        // they are not what the picture is of. Anchoring to the start is a
        // single cheap rule that encodes exactly that.
        if (!flat.startsWith(`${forename} ${surname}`)) return null

        // Group and object shots that still lead with the name.
        if (/\b(and|with|&)\b/.test(flat)) return null
        if (/\b(squad|team|group|lineup|line up|players|fans|crowd|panel|family|statue|mural|graffiti|poster|shirt|jersey|boots?|museum|waxwork)\b/.test(flat)) return null

        const em = ii.extmetadata || {}
        const licence = String(em.LicenseShortName?.value || '')
        if (!/^(CC|Public domain|CC0)/i.test(licence)) return null

        const w = Number(ii.width) || 0
        const h = Number(ii.height) || 0
        if (w < 640) return null

        // How old the photograph is. A 1990s picture illustrating a 2026 story
        // is wrong even when it is the right person, so age is scored hard.
        const dateRaw = String(em.DateTimeOriginal?.value || em.DateTime?.value || '')
        const year = Number((dateRaw.match(/(19|20)\d{2}/) || [])[0]) || 0
        const age = year ? thisYear - year : 12
        const ratio = w / Math.max(1, h)

        return {
          url: String(ii.thumburl),
          credit: stripTags(String(em.Artist?.value || 'Wikimedia Commons')).replace(/\s+/g, ' ').trim().slice(0, 80),
          licence,
          year,
          // Recency dominates; framing breaks ties.
          score: -age * 2 - Math.abs(ratio - 1.5) * 3,
        }
      })
      .filter(Boolean) as (CommonsImage & { score: number; year: number })[]

    const pick = scored.filter((c) => !taken.has(c.url)).sort((a, b) => b.score - a.score)[0]
    return pick ? { url: pick.url, credit: pick.credit, licence: pick.licence } : null
  } catch {
    return null
  }
}

/**
 * A cover photograph for the story, avoiding any already used today.
 *
 * Two stories built from the same outlet's coverage resolve to the same
 * og:image, and the page then shows one photograph twice under two different
 * headlines — which reads as a broken site even when the stories differ. So
 * every candidate is checked against what today has already used, and a story
 * that can only produce a duplicate gets no photograph at all: the generated
 * cover art is always distinct, so no image is better than the same one twice.
 */
const pickStoryImage = async (story: StoryCluster, taken: Set<string> = new Set()): Promise<string> => {
  const free = (u: string) => usableImage(u) && !taken.has(u)

  const fromFeed = story.members.map((m) => m.thumbnail).find(free)
  if (fromFeed) return fromFeed

  // Try the best-corroborated reports first; stop at the first unused hit.
  for (const m of story.members.slice(0, 4)) {
    if (!m.link || m.link.includes('news.google.com')) continue
    const og = await scrapeOgImage(m.link)
    if (og && !taken.has(og)) return og
  }
  return ''
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

/** Token counts DeepSeek reports back on every response, used to price a call. */
export type DeepSeekUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
}

export const callDeepSeek = async (
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  /**
   * Called with the response's token counts before the content is parsed, so a
   * caller can meter what it actually spent. It fires even when the reply turns
   * out to be unusable — those tokens are billed too.
   */
  onUsage?: (usage: DeepSeekUsage) => void,
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
  if (onUsage) {
    try { onUsage((payload?.usage || {}) as DeepSeekUsage) } catch { /* metering must never fail the call */ }
  }
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

/**
 * Score every candidate story 0-10 for how much a United supporter would care.
 *
 * The significance test used to be a keyword regex over the headline. That is a
 * guess about importance dressed up as a rule: it cannot tell "United Confirm
 * Signing Of A 17-Year-Old Third-Choice Keeper" from "United Confirm Sale Of The
 * Club", it scores both on the word "confirm", and anything phrased outside its
 * vocabulary is invisible to it no matter how big — which is exactly how the
 * Rashford story was missed.
 *
 * So the model decides instead. One call rates the whole candidate list at once:
 * a few hundred tokens against the ~4,000 a single article costs, so it runs on
 * every cycle without meaningfully changing the bill. The regex survives as the
 * fallback for when this call fails, because a worse signal beats no signal.
 */
export const triageStories = async (
  apiKey: string,
  model: string,
  stories: { title: string; outlets: string[] }[],
): Promise<number[]> => {
  if (!stories.length) return []
  const list = stories
    .map((s, i) => `${i + 1}. ${s.title}  [${s.outlets.length} outlet${s.outlets.length === 1 ? '' : 's'}]`)
    .join('\n')

  const system = `You are the news editor of a Manchester United site, deciding what is worth the desk's time today.

Score each headline 0-10 for how much a Manchester United supporter would care.

9-10  The club is unmistakably changed: a signing or sale completed, a manager appointed or sacked, a takeover or ownership change, a major long-term injury, a senior player leaving or returning to the squad.
7-8   Firm and consequential: a fee agreed, a medical booked, a contract signed or refused, a player back in training, a decisive team-selection call before a big fixture, a serious financial or ownership development.
4-6   Real but ordinary: squad news, form, a well-sourced link to a target, youth progress, pre-match and post-match matter.
1-3   Speculation, "could", "eyeing", "monitoring", listicles, polls, nostalgia, betting odds.
0     Not about Manchester United at all, or pure clickbait.

Judge the substance, not the wording. A confirmed but trivial event is not an 8. A huge story written flatly is still huge. A rumour phrased as fact is still a rumour.

Respond with a single JSON object: {"scores":[{"n":1,"s":7},...]} covering every numbered headline, and nothing else.`

  try {
    const parsed = await callDeepSeek(apiKey, model, system, list)
    const raw = Array.isArray(parsed?.scores) ? parsed.scores : []
    const out = new Array(stories.length).fill(-1)
    for (const row of raw) {
      const i = Number(row?.n) - 1
      const s = Number(row?.s)
      if (Number.isInteger(i) && i >= 0 && i < out.length && Number.isFinite(s)) {
        out[i] = Math.max(0, Math.min(10, s))
      }
    }
    return out
  } catch (err) {
    console.warn('[triage] scoring failed, falling back to keywords:', (err as Error).message)
    return new Array(stories.length).fill(-1)
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

const buildLengthCorrection = (shortBy: number): string => `
YOUR PREVIOUS ATTEMPT WAS REJECTED FOR BEING TOO SHORT.
It fell roughly ${shortBy} words below the minimum. Do not pad it with filler or restate what you have already said. Instead go deeper: add the context the sources give that you left out, develop your verdict with an actual argument, and say what this changes for the squad or the season. Write the full 500 to 750 words.
Remember to bold the key phrase in the opening with <strong>, and to use <strong> two or three times in total across the piece.
`

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
      // Articles written before the byline change are stored with the old
      // machine byline. Normalise on read rather than migrating the blob, so
      // the fix applies immediately and cannot half-succeed.
      articles: Array.isArray(data.articles)
        ? data.articles.map((a) => (LEGACY_BYLINES.has(a.author) ? { ...a, author: AUTHOR_NAME } : a))
        : [],
      pending: Array.isArray(data.pending) ? data.pending : [],
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
  kind: ArticleKind,
  varietyNote: string,
  archiveNote = '',
  archiveIds: Set<string> = new Set(),
  takenImages: Set<string> = new Set(),
  clubStateNote = '',
): Promise<WriteOutcome> => {
  let correction = ''
  let calls = 0
  let lastReason = 'unknown'

  // Resolved once, before any generation, so a retry does not re-scrape.
  const image = await pickStoryImage(story, takenImages)

  for (let attempt = 0; attempt < 2; attempt++) {
    calls++
    const parsed = await callDeepSeek(
      apiKey,
      model,
      [
        UNITED_ROAD_BRAIN,
        // Before the mode brief, so current fact outranks house style.
        clubStateNote,
        kind === 'news' ? NEWS_MODE_BRIEF
          : kind === 'match' ? MATCH_MODE_BRIEF
          : kind === 'weekly' ? WEEKLY_MODE_BRIEF
          : ARTICLE_MODE_BRIEF,
        ANTI_TEMPLATE,
        varietyNote,
        archiveNote,
      ]
        .filter(Boolean)
        .join('\n'),
      buildUserPrompt(story, otherStories, alreadyWritten, correction),
    )

    const result = validate(parsed, story, model, kind, image, archiveIds)
    if (result.ok) return { ...result, calls }

    lastReason = result.reason
    if (result.copiedPhrases?.length) {
      correction = buildCorrection(result.copiedPhrases)
    } else if (result.shortBy) {
      correction = buildLengthCorrection(result.shortBy)
    } else if (result.genericHeadings?.length) {
      correction = `
YOUR PREVIOUS ATTEMPT WAS REJECTED FOR TEMPLATE HEADINGS.
You used: ${result.genericHeadings.map((h) => `"${h}"`).join(', ')}.
Those are labels, not headings. Name each section for what is actually in it, in the words a person would use about this specific story. If a section does not need a heading, run the piece straight through instead.
`
    } else {
      break
    }
  }

  return { ok: false, reason: lastReason, calls }
}

// A draft this short is not a publishable article, and the model reliably
// under-runs the brief on a first pass — so shortness is treated as a
// retry-able fault rather than a reason to abandon the story.
const MIN_WORDS: Record<ArticleKind, number> = { news: 230, article: 480, match: 380, weekly: 480 }

type ValidateResult =
  | { ok: true; article: StoredArticle }
  | { ok: false; reason: string; copiedPhrases?: string[]; shortBy?: number; genericHeadings?: string[] }

// Headings that mark a piece as written to a template rather than about a story.
const BANNED_HEADINGS = [
  'what we know', 'what it means', 'latest developments', 'what happens next',
  'final thoughts', 'the bigger picture', 'my view', 'background', 'overview',
  'conclusion', 'analysis', 'introduction', 'the story so far',
]

const validate = (parsed: any, story: StoryCluster, model: string, kind: ArticleKind, image: string, archiveIds: Set<string> = new Set()): ValidateResult => {
  const title = stripTags(parsed?.title || '').slice(0, 160)
  const bodyHtml = sanitizeHtml(parsed?.bodyHtml || '')

  if (!title) return { ok: false, reason: 'no usable title' }

  const words = wordCount(bodyHtml)
  const floor = MIN_WORDS[kind]
  if (words < floor) {
    return { ok: false, reason: `only ${words} words of body copy`, shortBy: floor - words }
  }

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

  // Generic furniture is the clearest sign of template writing, and the model
  // reaches for it unless stopped. Caught here rather than trusted to the
  // prompt alone.
  const headings = [...bodyHtml.matchAll(/<h2>(.*?)<\/h2>/gi)].map((m) => stripTags(m[1]).toLowerCase().trim())
  const banned = headings.filter((h) => BANNED_HEADINGS.some((b) => h === b || h === `${b}?`))
  if (banned.length) {
    return { ok: false, reason: `generic section heading(s): ${banned.join(', ')}`, genericHeadings: banned }
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
      // Only people the piece is actually about, capped so a name-dropping
      // paragraph cannot spawn ten topic pages.
      people: Array.isArray(parsed?.people)
        ? parsed.people
            .map((n: unknown) => stripTags(String(n)).replace(/\s+/g, ' ').trim().slice(0, 40))
            .filter((n: string) => /^[\p{L}][\p{L}'’.\- ]{2,}$/u.test(n))
            .slice(0, 4)
        : [],
      // The writer may only point at ids we actually gave it, so a hallucinated
      // link cannot reach the page.
      relatedIds: Array.isArray(parsed?.relatedIds)
        ? parsed.relatedIds.filter((r: unknown) => typeof r === 'string' && archiveIds.has(r as string)).slice(0, 3)
        : [],
      titleOptions: Array.isArray(parsed?.titleOptions)
        ? parsed.titleOptions.map((t: unknown) => stripTags(String(t)).slice(0, 160)).filter(Boolean).slice(0, 3)
        : [],
      category: stripTags(parsed?.category || 'NEWS').toUpperCase().slice(0, 24),
      shape: stripTags(parsed?.shape || '').toUpperCase().slice(0, 12),
      kind,
      tone: stripTags(parsed?.tone || '').toLowerCase().slice(0, 12),
      author: AUTHOR_NAME,
      isAI: true,
      image,
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
  const newsToday = publishedToday.filter((a) => a.kind !== 'article' && a.kind !== 'weekly').length
  const articlesToday = publishedToday.filter((a) => a.kind === 'article').length

  // Headroom per kind. Forcing ignores the daily ceilings but never the
  // per-run one, so a manual trigger cannot run away.
  const BREAKING_WINDOW = 30 * 60 * 1000
  const newsRoom = opts.force ? BATCH.newsPerDayMax : Math.max(0, BATCH.newsPerDay - newsToday)
  const articleRoom = opts.force ? BATCH.articlesPerDay : Math.max(0, BATCH.articlesPerDay - articlesToday)
  const perRun = Math.max(1, Math.min(opts.max ?? BATCH.maxPerRun, BATCH.maxPerRun))

  // A full day does NOT stop the desk looking.
  //
  // This used to return here, and the comment above it claimed the opposite of
  // what the code did — it said fetching anyway was "the only way to discover
  // whether something big has broken", and then returned before fetching
  // anything. So from the moment the ordinary quota was spent, usually early
  // afternoon, the desk was blind for the rest of the day: it never read the
  // feeds, never scored a story, and breaksCap — the whole mechanism for letting
  // a big story through — could not run, because there were no stories to test.
  // A signing confirmed at nine in the evening was never even seen.
  //
  // So the run always reads the feeds and always scores them. What an exhausted
  // quota means is only that ordinary stories get no room; a story that clears
  // the significance bar is written regardless of the hour.
  const quotaSpent = newsRoom === 0 && articleRoom === 0 && !opts.force
  if (quotaSpent) {
    notes.push(
      `Daily ceilings reached (${newsToday}/${BATCH.newsPerDay} news, ${articlesToday}/${BATCH.articlesPerDay} articles) — still checking for anything significant.`,
    )
  }

  const clubStateNote = buildClubStateNote(await readClubState())
  if (!clubStateNote) notes.push('No current club state established yet — run /api/refresh-club-state.')

  let stories = await gatherStories(index.covered)
  if (stories.length === 0) {
    // The common case on a five-minute poll: nothing new since last time.
    // Costs one round of feed fetches and no DeepSeek call at all.
    return { status: 'nothing-to-write', published: [], storiesAvailable: 0, notes: ['No uncovered United stories in the feeds.'] }
  }

  // Two different signals, deliberately kept apart.
  //
  // "Urgent" means it landed in the last half hour, and is the only thing that
  // should force a story out as a short news item so it goes live fast.
  //
  // "Corroborated" means several outlets are running it, which says the story
  // matters — not that it is time-critical. Folding corroboration into
  // urgency was a mistake: on a busy day everything looked urgent, every slot
  // went to news, and the three daily long-form articles were never written.
  // A result reads differently from a rumour: a scoreline in the headline, or
  // the vocabulary of a finished game. These become match reports.
  const RESULT_PATTERNS = [
    /\b\d\s*[-\u2013]\s*\d\b/,
    /\b(full[- ]time|player ratings|match report|beat|thrash|held to|slump to|edge past|see off|come from behind)\b/i,
    /\b(win|defeat|draw|loss)\b.*\b(against|vs|over|at)\b/i,
  ]
  const isResult = (c: StoryCluster) => RESULT_PATTERNS.some((r) => r.test(c.lead.title))

  const isUrgent = (c: StoryCluster) => Date.now() - c.timestamp < BREAKING_WINDOW
  const urgentCount = stories.filter(isUrgent).length
  if (urgentCount) notes.push(`${urgentCount} story/stories broke in the last 30 minutes.`)

  /**
   * Big enough to publish even though the day's quota is used up.
   *
   * Two independent routes, because they catch different things.
   *
   * The time gates here were both 30 minutes and that was the bug: once the
   * day's quota was spent, breaksCap was the only way anything reached the site,
   * and it demanded the story be less than half an hour old. A confirmed club
   * event picked up 40 minutes after it broke — which is ordinary, since feeds
   * lag publication and corroboration takes time to gather — was silently
   * dropped for the rest of the day. Real stories were being missed for being
   * slightly too late rather than for being too small.
   *
   * So confirmation no longer has a time gate at all. A completed signing, a
   * sacking, a player rejoining the squad is worth covering whether it landed
   * twenty minutes ago or this morning; what stops it being written twice is the
   * covered-story index, not the clock. Corroboration keeps a window, because a
   * pile-on is only evidence of something breaking if it happened in a burst,
   * but three hours is the realistic span for several desks to file.
   */
  const CORROBORATION_WINDOW = 3 * 60 * 60 * 1000
  const CONFIRMED =
    /\b(sign(s|ed|ing)?|complete[ds]?|confirm(s|ed)|announce[ds]?|unveil(s|ed)|sack(s|ed)|appoint(s|ed)|depart(s|ure)|exit|joins?|rejoins?|return(s|ing|ed)?|recall(s|ed)|agree[ds]?|medical|contract|deal|injur(y|ed|ies)|ruled out|out for|suspend(s|ed)|ban(ned)?|takeover|stake)\b/i

  // Editorial judgement first, keywords only if the call failed (score -1).
  const scores = await triageStories(
    apiKey,
    model,
    stories.map((s) => ({ title: s.lead.title, outlets: s.outlets })),
  )
  const scoreOf = (i: number) => scores[i] ?? -1

  // A story that has been waiting keeps the significance it was given, and
  // gains a little each run it is passed over, so nothing starves.
  const pendingByKey = new Map((index.pending || []).map((p) => [p.key, p]))
  const keyOf = (c: StoryCluster) => normaliseTitle(c.lead.title)
  // Escalation is capped at a single point on purpose. It lets a 7 — "firm and
  // consequential", which is where a story like a senior player rejoining the
  // squad lands — reach the bar after two runs, about ten minutes, so it is
  // published the same evening rather than waiting for the next day's quota. It
  // deliberately cannot lift ordinary squad news at 6 over the bar however long
  // it waits, or every quiet day would eventually spend its hard ceiling on
  // filler. Below the bar is not lost, only queued.
  const effectiveScore = (c: StoryCluster, i: number) => {
    const held = pendingByKey.get(keyOf(c))
    const base = Math.max(scoreOf(i), held?.score ?? -1)
    return base < 0 ? -1 : Math.min(10, base + Math.min(1, (held?.waits ?? 0) * 0.5))
  }

  const breaksCap = (c: StoryCluster, i: number) => {
    const s = effectiveScore(c, i)
    if (s >= 0) return s >= BATCH.breakCapScore
    // Fallback only — the model did not answer.
    return (
      (c.outlets.length >= BATCH.breakCapOutlets && Date.now() - c.timestamp < CORROBORATION_WINDOW) ||
      (CONFIRMED.test(c.lead.title) && c.outlets.length >= 2)
    )
  }

  // Decide significance once, then carry it with the story. Sorting and the
  // pending queue both need it, and re-deriving it invites the two disagreeing.
  const ranked = stories.map((c, i) => ({
    story: c,
    score: effectiveScore(c, i),
    big: breaksCap(c, i),
  }))

  let newsAllowance = newsRoom
  let articleAllowance = articleRoom
  const bigStories = ranked.filter((r) => r.big)

  if (!opts.force && bigStories.length) {
    // Only ever enough room for the big stories themselves, and never past the
    // hard ceiling.
    const extraNews = Math.max(0, Math.min(bigStories.length, BATCH.newsPerDayMax - newsToday) - newsAllowance)
    const extraArticles = Math.max(0, Math.min(1, BATCH.articlesPerDayMax - articlesToday) - articleAllowance)
    if (extraNews > 0 || extraArticles > 0) {
      newsAllowance += extraNews
      articleAllowance += extraArticles
      notes.push(
        `${bigStories.length} story/stories cleared the significance bar, so the day's quota was extended by ${extraNews} news and ${extraArticles} article(s).`,
      )
    }
  }

  // Most significant first, so if anything goes unwritten it is the least
  // important thing on the list rather than whatever happened to sort last.
  ranked.sort((a, b) => Number(b.big) - Number(a.big) || b.score - a.score)
  stories = ranked.map((r) => r.story)
  const scoreByKey = new Map(ranked.map((r) => [normaliseTitle(r.story.lead.title), r.score]))
  const topScore = ranked.length ? Math.max(...ranked.map((r) => r.score)) : -1
  if (topScore >= 0) notes.push(`Top significance score this run: ${topScore}/10.`)

  const published: StoredArticle[] = []
  const writtenTitles = publishedToday.map((a) => a.title)
  const coveredNow = [...index.covered]

  // Same matcher gatherStories uses, built over this run's headlines so the
  // in-loop duplicate check below behaves identically to the pre-run filter.
  const sameStory = makeSameStory(
    stories.flatMap((c) => [c.lead.title, ...c.members.map((m) => m.title)]),
  )

  // Show the writer the furniture it has used recently so consecutive pieces do
  // not all carry the same headings and the same opening construction.
  const recent = index.articles.slice(0, 12)
  const recentHeadings = recent.flatMap((a) =>
    [...a.content.matchAll(/<h2>(.*?)<\/h2>/gi)].map((m) => stripTags(m[1])),
  )
  const recentOpenings = recent.map((a) => stripTags(a.content).split(/\s+/).slice(0, 7).join(' '))

  let newsLeft = newsAllowance
  let articlesLeft = articleAllowance
  const callBudget = perRun * 2 + 2
  let callsUsed = 0

  notes.push(
    `${stories.length} uncovered stories; room for ${newsRoom} news and ${articleRoom} article(s) today, up to ${perRun} this run.`,
  )

  // Images already spoken for. Two clusters built from the same outlet's page
  // resolve to the same og:image, and the site then shows one photograph twice
  // in a row under two different headlines, which looks broken even when the
  // stories genuinely differ.
  const usedImages = new Set(
    publishedToday.map((a) => a.image).filter(Boolean),
  )

  for (let i = 0; i < stories.length && published.length < perRun && callsUsed < callBudget; i++) {
    const story = stories[i]
    if (newsLeft === 0 && articlesLeft === 0) break

    // Skip anything this run has already covered.
    //
    // gatherStories filters against the covered list as it was when the run
    // started, and nothing re-checked it as pieces were written. So when
    // clustering left two near-identical clusters — the same story filed by
    // outlets whose headlines did not overlap quite enough to merge — both were
    // written, one as news and one as an article, from the same source material.
    // They came out with the same headline and the same photograph, one above
    // the other on the page. One story gets one piece.
    if (coveredNow.some((prev) => sameStory(prev.title, story.lead.title)) ||
        story.members.some((m) => coveredNow.some((prev) => sameStory(prev.title, m.title)))) {
      continue
    }

    // One long-form piece per run at most, taken from the best-corroborated
    // story available, so the daily article quota actually gets filled even
    // when the feeds are busy. Everything else goes out as news.
    const wroteArticleThisRun = published.some((p) => p.kind === 'article')
    let kind: ArticleKind
    // A result is always worth its own report, and counts against the news cap.
    if (isResult(story) && newsLeft > 0) {
      kind = 'match'
    } else if (articlesLeft > 0 && !wroteArticleThisRun && story.outlets.length >= 2 && !isUrgent(story)) {
      kind = 'article'
    } else if (newsLeft > 0) {
      kind = 'news'
    } else {
      kind = 'article'
    }

    const others = stories.filter((_, n) => n !== i)

    try {
      const varietyNote = buildVarietyNote(
        [...recentHeadings, ...published.flatMap((p) => [...p.content.matchAll(/<h2>(.*?)<\/h2>/gi)].map((m) => stripTags(m[1])))],
        [...recentOpenings, ...published.map((p) => stripTags(p.content).split(/\s+/).slice(0, 7).join(' '))],
        // Seeded on how much the site has published, so the shape advances with
        // every piece rather than resetting each run.
        index.articles.length + published.length,
      )
      // Our own back catalogue, so the piece can point at what we already have.
      const archive = [...published, ...index.articles]
        .slice(0, 40)
        .map((a) => ({ id: a.id, title: a.title, date: a.date }))
      const outcome = await writeOne(
        apiKey, model, story, others, writtenTitles, kind, varietyNote,
        buildArchiveNote(archive), new Set(archive.map((a) => a.id)), usedImages, clubStateNote,
      )
      callsUsed += outcome.calls
      if (!outcome.ok) {
        notes.push(`Skipped "${story.lead.title.slice(0, 60)}": ${outcome.reason}.`)
        continue
      }
      if (published.some((p) => overlapRatio(normaliseTitle(p.title), normaliseTitle(outcome.article.title)) > 0.6)) {
        notes.push(`Skipped "${outcome.article.title.slice(0, 60)}": duplicates an article from this run.`)
        continue
      }

      published.push(outcome.article)
      writtenTitles.push(outcome.article.title)
      if (kind === 'article') articlesLeft--
      else newsLeft--

      // No usable photograph from the reporting — either none was offered or
      // the only candidate was already used today. Rather than fall straight to
      // generated art, look for a free-licensed photograph of whoever the piece
      // is actually about. The writer has just told us in `people`.
      if (!outcome.article.image) {
        for (const person of outcome.article.people || []) {
          const found = await findCommonsImage(person, usedImages)
          if (found) {
            outcome.article.image = found.url
            outcome.article.imageCredit = `${found.credit} / ${found.licence}`
            notes.push(`Cover for "${outcome.article.title.slice(0, 40)}" from Wikimedia Commons (${person}).`)
            break
          }
        }
      }
      if (outcome.article.image) usedImages.add(outcome.article.image)
      coveredNow.unshift(
        { title: outcome.article.title, at: Date.now() },
        ...story.members.map((m) => ({ title: m.title, at: Date.now() })),
      )
    } catch (err) {
      callsUsed++
      notes.push(`Failed on "${story.lead.title.slice(0, 60)}": ${(err as Error).message}`)
    }
  }

  /**
   * Remember everything we did not write.
   *
   * This is the guarantee that a story cannot be lost to the clock. Anything
   * left on the table — because the quota was spent, because the run hit its
   * per-run limit, because a write failed — is carried forward with its
   * significance intact and its wait count incremented, which nudges it up the
   * order next time. The moment there is room, including at the daily reset,
   * these are the stories in front.
   *
   * Only things worth a second look are kept: scored 4 or better, or unscored
   * (so a triage failure cannot quietly bin the day's news). Entries stop being
   * carried once they are covered, once they have gone unwritten for three days
   * — by then the feeds no longer hold the reporting to write from — or once the
   * queue is full, oldest and least significant first.
   */
  const publishedKeys = new Set(published.map((p) => normaliseTitle(p.title)))
  const seenNow = new Set(stories.map((s) => normaliseTitle(s.lead.title)))
  const PENDING_TTL = 3 * 24 * 60 * 60 * 1000
  const now = Date.now()

  const carried: PendingStory[] = []
  for (const s of stories) {
    const key = normaliseTitle(s.lead.title)
    if (publishedKeys.has(key)) continue
    const score = scoreByKey.get(key) ?? -1
    if (score >= 0 && score < 4) continue
    const held = pendingByKey.get(key)
    carried.push({
      key,
      title: s.lead.title,
      firstSeen: held?.firstSeen ?? now,
      lastSeen: now,
      outlets: Math.max(s.outlets.length, held?.outlets ?? 0),
      score: Math.max(score, held?.score ?? -1),
      waits: (held?.waits ?? 0) + 1,
    })
  }
  // Keep queued stories that simply fell out of this run's feed window; they
  // may resurface, and forgetting them is the failure this queue exists to stop.
  for (const held of pendingByKey.values()) {
    if (publishedKeys.has(held.key) || seenNow.has(held.key)) continue
    if (now - held.firstSeen > PENDING_TTL) continue
    carried.push(held)
  }
  const pending = carried
    .sort((a, b) => b.score - a.score || b.lastSeen - a.lastSeen)
    .slice(0, 60)

  if (pending.length) {
    notes.push(`${pending.length} story/stories held for the next run rather than dropped.`)
  }

  if (published.length === 0) {
    await writeIndex({ ...index, updatedAt: Date.now(), pending })
    return { status: 'nothing-to-write', published: [], storiesAvailable: stories.length, notes }
  }

  await writeIndex({
    ...index,
    updatedAt: Date.now(),
    covered: coveredNow.slice(0, COVERED_MEMORY),
    pending,
    articles: [
      ...published,
      ...index.articles.filter((a) => !published.some((p) => p.id === a.id)),
    ].slice(0, 400),
  })

  return { status: 'published', published, storiesAvailable: stories.length, notes }
}


// --- Weekly round-up -----------------------------------------------------

/**
 * Write the week in review from what the desk itself published.
 *
 * Deliberately not sourced from the feeds: this is a look back at our own
 * coverage, so the only material it gets is our own headlines and standfirsts.
 * That also means it cannot introduce a fact the site has not already reported.
 */
export const publishRoundup = async (): Promise<{ status: string; title?: string; reason?: string }> => {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) return { status: 'skipped', reason: 'DEEPSEEK_API_KEY is not set.' }

  const model = process.env.DEEPSEEK_MODEL || DEFAULT_MODEL
  const index = await readIndex()
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000

  const week = index.articles.filter((a) => a.timestamp >= weekAgo && a.kind !== 'weekly')
  if (week.length < 4) return { status: 'skipped', reason: `Only ${week.length} pieces published this week.` }

  // Already done one this week?
  if (index.articles.some((a) => a.kind === 'weekly' && a.timestamp >= weekAgo)) {
    return { status: 'skipped', reason: 'A round-up has already gone out this week.' }
  }

  const material = week
    .map((a, i) => `[${i + 1}] ${a.title}\n    ${a.standfirst || a.excerpt || ''}`)
    .join('\n\n')

  const parsed = await callDeepSeek(
    apiKey,
    model,
    `${UNITED_ROAD_BRAIN}\n${WEEKLY_MODE_BRIEF}\n${ANTI_TEMPLATE}`,
    `Here is everything United Road published in the last seven days.\n\n${material}\n\nWrite the weekly round-up. Respond with the JSON object only.`,
  )

  const title = stripTags(parsed?.title || '').slice(0, 160)
  const bodyHtml = sanitizeHtml(parsed?.bodyHtml || '')
  const words = wordCount(bodyHtml)
  if (!title || words < 400) return { status: 'skipped', reason: `Round-up came back too thin (${words} words).` }

  const now = new Date()
  const article: StoredArticle = {
    id: `ur-weekly-${now.toISOString().slice(0, 10)}`,
    title,
    standfirst: stripTags(parsed?.standfirst || '').slice(0, 260),
    excerpt: stripTags(parsed?.standfirst || '').slice(0, 200),
    content: bodyHtml,
    tags: ['week in review'],
    category: 'THE WEEK',
    shape: 'WEEKLY',
    tone: stripTags(parsed?.tone || '').toLowerCase().slice(0, 12),
    kind: 'weekly',
    author: AUTHOR_NAME,
    isAI: true,
    image: week.find((a) => a.image)?.image || '',
    date: now.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' }),
    timestamp: now.getTime(),
    readMinutes: Math.max(1, Math.round(words / 220)),
    sources: [],
    model,
  }

  await writeIndex({
    ...index,
    updatedAt: Date.now(),
    articles: [article, ...index.articles].slice(0, 400),
  })

  return { status: 'published', title }
}

// --- Current club state --------------------------------------------------
//
// The failure this fixes: a model states a fact it learned in training as
// though it were current. It is how "Ruben Amorim" gets written under a 2026
// dateline when Michael Carrick has the job, and no amount of instruction fixes
// it, because the model does not know its own knowledge is stale.
//
// Note carefully that DeepSeek cannot solve this by being asked. It has a
// training cutoff of its own, so "who manages United?" gets the same confident,
// possibly wrong answer from it as from any other model. What it can do is
// *read*. The feeds this site already polls every five minutes are live, and
// extracting a fact from supplied text is a different task from recalling one.
//
// So this reads the day's reporting and pulls out only what that reporting
// actually states. Anything not stated comes back null and the previous value
// stands, which means a quiet news day never erases what we know, and a wrong
// value is corrected the moment the feeds contradict it.

export type ClubState = {
  manager: string | null
  managerSince: string | null
  ownership: string | null
  competition: string | null
  notes: string[]
  updatedAt: number
  /** Headlines the last extraction was drawn from, so a wrong value is traceable. */
  basis: string[]
}

const CLUB_STATE_KEY = 'club-state.json'

const EMPTY_CLUB_STATE: ClubState = {
  manager: null, managerSince: null, ownership: null,
  competition: null, notes: [], updatedAt: 0, basis: [],
}

export const readClubState = async (): Promise<ClubState> => {
  try {
    const data = (await store().get(CLUB_STATE_KEY, { type: 'json' })) as ClubState | null
    return data ? { ...EMPTY_CLUB_STATE, ...data } : { ...EMPTY_CLUB_STATE }
  } catch {
    return { ...EMPTY_CLUB_STATE }
  }
}

/**
 * The block injected into every writing prompt.
 *
 * Deliberately says where the facts came from and when. A model told "this is
 * what the reporting says today" treats it as evidence; a model told "the
 * manager is X" treats it as one more thing it half-remembers and may argue
 * with. It also carries the instruction that matters most: prefer this over
 * anything you think you know.
 */
export const buildClubStateNote = (state: ClubState): string => {
  const lines: string[] = []
  if (state.manager) lines.push(`- Head coach: ${state.manager}${state.managerSince ? ` (since ${state.managerSince})` : ''}`)
  if (state.ownership) lines.push(`- Ownership: ${state.ownership}`)
  if (state.competition) lines.push(`- Where the season stands: ${state.competition}`)
  for (const n of state.notes.slice(0, 6)) lines.push(`- ${n}`)
  if (!lines.length) return ''

  const age = state.updatedAt ? Math.round((Date.now() - state.updatedAt) / 3600000) : 0
  return `
WHAT IS TRUE AT MANCHESTER UNITED RIGHT NOW
Established from this week's reporting${age ? `, ${age} hour(s) ago` : ''}. This is current. Your own training is not — where the two disagree, this wins, every time. Never name a manager, owner or squad member from memory.
${lines.join('\n')}
`
}

/**
 * Re-derive the current facts from live reporting.
 *
 * Cheap: one call over headlines and summaries we have already fetched.
 */
export const refreshClubState = async (): Promise<{ status: string; state?: ClubState; reason?: string }> => {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) return { status: 'skipped', reason: 'DEEPSEEK_API_KEY is not set.' }
  const model = process.env.DEEPSEEK_MODEL || DEFAULT_MODEL

  const stories = await gatherStories([])
  if (stories.length < 3) return { status: 'skipped', reason: `Only ${stories.length} stories available.` }

  const material = stories
    .slice(0, 30)
    .map((c, i) => `[${i + 1}] ${c.lead.title}\n    ${stripTags(c.lead.description || '').slice(0, 220)}`)
    .join('\n')

  const system = `You extract facts from supplied reporting. You do not answer from memory.

Read the Manchester United reporting below and state only what it establishes. If the reporting does not establish something, return null for it — do NOT fill it in from what you believe to be true. Your training data is older than this reporting and may be wrong; the reporting wins.

A name appearing in a headline is not proof of a role. "Carrick's side beat Arsenal" establishes he is the head coach. "United considering Carrick" does not.

Respond with a single JSON object and nothing else:
{
  "manager": "Full name of the current Manchester United head coach, or null if the reporting does not make it clear",
  "managerSince": "Month and year they took charge if stated, else null",
  "ownership": "One clause on who controls the club, e.g. 'Glazer family majority owners, INEOS running football operations', or null",
  "competition": "One clause on where the season stands, e.g. 'Pre-season, 2026/27 Premier League campaign starts this month', or null",
  "notes": ["Up to 4 short factual statements the reporting establishes that a writer would need — a major signing completed, a long-term injury, a captaincy change. Nothing speculative."]
}`

  const parsed = await callDeepSeek(apiKey, model, system, material)
  const prev = await readClubState()
  const text = (v: unknown, max = 160) =>
    typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null'
      ? stripTags(v).replace(/\s+/g, ' ').trim().slice(0, max)
      : null

  // A null keeps the previous value. A quiet week must not erase what we know.
  const state: ClubState = {
    manager: text(parsed?.manager, 60) ?? prev.manager,
    managerSince: text(parsed?.managerSince, 40) ?? prev.managerSince,
    ownership: text(parsed?.ownership) ?? prev.ownership,
    competition: text(parsed?.competition) ?? prev.competition,
    notes: Array.isArray(parsed?.notes)
      ? parsed.notes.map((n: unknown) => text(n, 180)).filter(Boolean).slice(0, 4) as string[]
      : prev.notes,
    updatedAt: Date.now(),
    basis: stories.slice(0, 8).map((c) => c.lead.title.slice(0, 110)),
  }

  if (prev.manager && state.manager && prev.manager !== state.manager) {
    console.log(`[club-state] head coach changed: ${prev.manager} -> ${state.manager}`)
  }

  try {
    await store().setJSON(CLUB_STATE_KEY, state)
  } catch (err) {
    return { status: 'error', reason: (err as Error).message }
  }
  return { status: 'ok', state }
}
