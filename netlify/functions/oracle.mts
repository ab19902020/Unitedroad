// The United Oracle, answered by DeepSeek instead of a lookup table.
//
// The chat previously matched on about ten hardcoded keywords and returned a
// canned paragraph; anything outside that list got the same "my archives are
// vast" fallback. This answers properly, with the same factual discipline the
// article desk uses: club history is fair game, current-season specifics are
// not, because the model has no feed here and would invent them.

import type { Config } from '@netlify/functions'
import { getStore } from '@netlify/blobs'
import { callDeepSeek } from '../lib/article-writer.mts'

// This endpoint spends the site owner's DeepSeek credit on behalf of anyone who
// can reach it, so it is bounded three ways before a call is ever made:
//
//   1. A cache. Fans ask the same dozen questions, so an identical question
//      inside the TTL is answered for free.
//   2. A hard daily ceiling on live calls across all visitors. Past it, the
//      offline answers take over — the feature degrades, it does not break.
//   3. A per-IP hourly cap, so one visitor cannot burn the daily ceiling on
//      their own. (Netlify's native rateLimit config is not used: the installed
//      SDK's RateLimitConfig has no request-count field, only a window size, so
//      declaring one would be silently ineffective.)
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000
const DAILY_CALL_LIMIT = Number(process.env.ORACLE_DAILY_LIMIT || 150)
const PER_IP_HOURLY_LIMIT = Number(process.env.ORACLE_IP_LIMIT || 15)

const store = () => getStore({ name: 'united-road-oracle', consistency: 'strong' })

// Normalised so "Who is our top scorer?" and "who is our top scorer" share a
// cache entry.
const cacheKey = (q: string) =>
  'q-' + q.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120).replace(/ /g, '-')

type Meter = { day: string; calls: number }
type IpMeter = { hour: string; calls: number }

const thisHour = () => new Date().toISOString().slice(0, 13)

// Hashed so the store never holds a raw visitor IP.
const ipKey = (ip: string) => {
  let h = 2166136261
  for (let i = 0; i < ip.length; i++) { h ^= ip.charCodeAt(i); h = Math.imul(h, 16777619) }
  return `ip-${Math.abs(h).toString(36)}`
}

const today = () => new Date().toISOString().slice(0, 10)

const readMeter = async (): Promise<Meter> => {
  try {
    const m = (await store().get('meter', { type: 'json' })) as Meter | null
    if (!m || m.day !== today()) return { day: today(), calls: 0 }
    return m
  } catch {
    return { day: today(), calls: 0 }
  }
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

  // 3. Daily ceiling.
  const meter = await readMeter()
  if (meter.calls >= DAILY_CALL_LIMIT) {
    console.warn(`[oracle] daily ceiling of ${DAILY_CALL_LIMIT} reached; serving offline answers.`)
    return Response.json({ error: 'limit' }, { status: 429 })
  }

  try {
    await store().setJSON('meter', { day: meter.day, calls: meter.calls + 1 })
    const answer = await callDeepSeek(
      apiKey,
      process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
      ORACLE_BRAIN,
      `${question}\n\nRespond with JSON: {"answer":"your reply as plain text"}`,
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
  }
}

export const config: Config = {
  path: '/api/oracle',
  method: 'POST',
}
