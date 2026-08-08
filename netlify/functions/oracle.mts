// The United Oracle, answered by DeepSeek instead of a lookup table.
//
// The chat previously matched on about ten hardcoded keywords and returned a
// canned paragraph; anything outside that list got the same "my archives are
// vast" fallback. This answers properly, with the same factual discipline the
// article desk uses: club history is fair game, current-season specifics are
// not, because the model has no feed here and would invent them.

import type { Config } from '@netlify/functions'
import { getStore } from '@netlify/blobs'
import { callDeepSeek, type DeepSeekUsage } from '../lib/article-writer.mts'

// This endpoint spends the site owner's DeepSeek credit on behalf of anyone who
// can reach it, so it is bounded three ways before a call is ever made:
//
//   1. A cache. Fans ask the same dozen questions, so an identical question
//      inside the TTL is answered for free.
//   2. A hard daily budget in real money, shared across all visitors. Past it,
//      the offline answers take over — the feature degrades, it does not break.
//   3. A per-IP hourly cap, so one visitor cannot burn the daily budget on
//      their own. (Netlify's native rateLimit config is not used: the installed
//      SDK's RateLimitConfig has no request-count field, only a window size, so
//      declaring one would be silently ineffective.)
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000
const PER_IP_HOURLY_LIMIT = Number(process.env.ORACLE_IP_LIMIT || 15)

// The budget is money, not a call count, because a call count is a guess about
// cost and this is a promise about it. DeepSeek returns exact token counts on
// every response, so what gets metered is what was actually billed.
const DAILY_PENCE_BUDGET = Number(process.env.ORACLE_DAILY_PENCE || 10)

// deepseek-v4-flash list prices, USD per million tokens. Cached input is priced
// separately and far cheaper, which matters here: every request repeats the same
// long system prompt, so most input tokens after the first are cache hits.
// If DEEPSEEK_MODEL is pointed at a dearer model these numbers understate the
// spend — override them with the env vars if so.
const USD_PER_M_CACHE_HIT = Number(process.env.ORACLE_PRICE_CACHE_HIT || 0.0028)
const USD_PER_M_CACHE_MISS = Number(process.env.ORACLE_PRICE_CACHE_MISS || 0.14)
const USD_PER_M_OUTPUT = Number(process.env.ORACLE_PRICE_OUTPUT || 0.28)

// Deliberately below the real rate. Under-stating dollars-per-pound over-states
// the pence a call costs, so drift in the exchange rate can only ever make the
// cap bite early — it can never let the day run past 10p.
const USD_PER_GBP = Number(process.env.ORACLE_USD_PER_GBP || 1.2)

const penceFor = (usage: DeepSeekUsage): number => {
  const hit = usage.prompt_cache_hit_tokens ?? 0
  const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, (usage.prompt_tokens ?? 0) - hit)
  const out = usage.completion_tokens ?? 0
  const usd =
    (hit * USD_PER_M_CACHE_HIT + miss * USD_PER_M_CACHE_MISS + out * USD_PER_M_OUTPUT) / 1_000_000
  return (usd / USD_PER_GBP) * 100
}

// Charged up front and reconciled against the real figure afterwards. Blob
// read-modify-write is not atomic, so without a reservation a burst of
// simultaneous questions would all read the same balance and all decide there
// was room. Sized well above a real exchange — roughly 1,200 uncached input
// tokens and a 600-token answer — so the pessimistic case is the one that races.
const RESERVE_PENCE = penceFor({ prompt_cache_miss_tokens: 1200, completion_tokens: 600 })

const store = () => getStore({ name: 'united-road-oracle', consistency: 'strong' })

// Normalised so "Who is our top scorer?" and "who is our top scorer" share a
// cache entry.
const cacheKey = (q: string) =>
  'q-' + q.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120).replace(/ /g, '-')

type Meter = { day: string; calls: number; pence: number }
type IpMeter = { hour: string; calls: number }

const thisHour = () => new Date().toISOString().slice(0, 13)

// Hashed so the store never holds a raw visitor IP.
const ipKey = (ip: string) => {
  let h = 2166136261
  for (let i = 0; i < ip.length; i++) { h ^= ip.charCodeAt(i); h = Math.imul(h, 16777619) }
  return `ip-${Math.abs(h).toString(36)}`
}

const today = () => new Date().toISOString().slice(0, 10)

const emptyMeter = (): Meter => ({ day: today(), calls: 0, pence: 0 })

const readMeter = async (): Promise<Meter> => {
  try {
    const m = (await store().get('meter', { type: 'json' })) as Meter | null
    if (!m || m.day !== today()) return emptyMeter()
    // Tolerates the pre-budget meter shape, which counted calls only.
    return { day: m.day, calls: m.calls ?? 0, pence: m.pence ?? 0 }
  } catch {
    return emptyMeter()
  }
}

/** Adds to today's running spend, re-reading first so a stale total is not written back. */
const chargeMeter = async (pence: number, calls = 0) => {
  try {
    const m = await readMeter()
    await store().setJSON('meter', { day: m.day, calls: m.calls + calls, pence: m.pence + pence })
  } catch { /* a metering failure must not take the endpoint down with it */ }
}

const ORACLE_BRAIN = `You are The United Oracle on unitedroad.uk — a Manchester United historian answering supporters' questions.

VOICE
British English, warm, direct, knowledgeable. Two to four short paragraphs at most, usually fewer. You are talking to someone who already supports United, so do not over-explain. No emoji, no exclamation marks, no "great question".

WHAT YOU KNOW
The club's history in depth: Newton Heath and 1878, the Busby Babes and Munich in 1958, the 1968 European Cup, Ferguson from 1986 to 2013, the 1999 treble and that night in Barcelona, Moscow 2008, the Class of '92, Old Trafford and the Stretford End, the club's records and its great players. Ownership history including the Glazers' 2005 leveraged buyout and the INEOS stake.

WHAT YOU MUST NOT DO
- Never invent a current fact. If asked about today's squad, this season's results, a live transfer, current injuries or the present league position, say plainly that you cover history and point them at the news and transfer pages of the site rather than guessing.
- Never invent a statistic, fee, date or quote. If you are not certain of a number, describe it without one.
- Never claim to have live data.
- If a question is not about Manchester United, say so briefly and steer back.

FORMAT
Plain text. No markdown, no headings, no bullet lists.`

export default async (req: Request) => {
  if (req.method !== 'POST') return Response.json({ error: 'Use POST.' }, { status: 405 })

  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) return Response.json({ error: 'unavailable' }, { status: 503 })

  let body: any = {}
  try { body = await req.json() } catch {}

  const question = String(body?.question || '').trim().slice(0, 500)
  if (!question) return Response.json({ error: 'No question.' }, { status: 400 })

  // 1. Cache.
  const key = cacheKey(question)
  try {
    const hit = (await store().get(key, { type: 'json' })) as { answer: string; at: number } | null
    if (hit?.answer && Date.now() - hit.at < CACHE_TTL) {
      return Response.json({ answer: hit.answer, cached: true }, { headers: { 'Cache-Control': 'no-store' } })
    }
  } catch { /* a cache miss must never fail the request */ }

  // 2. Per-IP hourly cap.
  const ip = req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const ipk = ipKey(ip)
  try {
    const rec = (await store().get(ipk, { type: 'json' })) as IpMeter | null
    const current = rec && rec.hour === thisHour() ? rec.calls : 0
    if (current >= PER_IP_HOURLY_LIMIT) {
      return Response.json({ error: 'limit' }, { status: 429 })
    }
    await store().setJSON(ipk, { hour: thisHour(), calls: current + 1 })
  } catch { /* never let the limiter itself break the endpoint */ }

  // 3. Daily budget. Reserve first, reconcile after — see RESERVE_PENCE.
  const meter = await readMeter()
  if (meter.pence + RESERVE_PENCE > DAILY_PENCE_BUDGET) {
    console.warn(
      `[oracle] today's ${DAILY_PENCE_BUDGET}p budget is spent (${meter.pence.toFixed(3)}p over ${meter.calls} calls); serving offline answers.`,
    )
    return Response.json({ error: 'limit' }, { status: 429 })
  }
  await chargeMeter(RESERVE_PENCE, 1)

  // Set from the response's token counts, so the reservation can be swapped for
  // the real figure. Stays null if the call never reached DeepSeek, in which
  // case nothing was billed and the reservation is released in full.
  let spent: number | null = null

  try {
    const answer = await callDeepSeek(
      apiKey,
      process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
      ORACLE_BRAIN,
      `${question}\n\nRespond with JSON: {"answer":"your reply as plain text"}`,
      (usage) => { spent = penceFor(usage) },
    )
    const text = String(answer?.answer || '').trim()
    if (!text) throw new Error('empty answer')
    try { await store().setJSON(key, { answer: text, at: Date.now() }) } catch {}
    return Response.json({ answer: text }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    // The page keeps its offline responses, so a failure here degrades rather
    // than breaking the feature.
    console.error('[oracle]', (err as Error).message)
    return Response.json({ error: 'unavailable' }, { status: 502 })
  } finally {
    // Settle up either way: a failed call that still burned tokens is still
    // charged, and one that never got off the ground gives its reservation back.
    await chargeMeter((spent ?? 0) - RESERVE_PENCE)
  }
}

export const config: Config = {
  path: '/api/oracle',
  method: 'POST',
}
