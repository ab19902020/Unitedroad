// The United Oracle, answered by DeepSeek instead of a lookup table.
//
// The chat previously matched on about ten hardcoded keywords and returned a
// canned paragraph; anything outside that list got the same "my archives are
// vast" fallback. This answers properly, with the same factual discipline the
// article desk uses: club history is fair game, current-season specifics are
// not, because the model has no feed here and would invent them.

import type { Config } from '@netlify/functions'
import { callDeepSeek } from '../lib/article-writer.mts'

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

  try {
    const answer = await callDeepSeek(
      apiKey,
      process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
      ORACLE_BRAIN,
      `${question}\n\nRespond with JSON: {"answer":"your reply as plain text"}`,
    )
    const text = String(answer?.answer || '').trim()
    if (!text) throw new Error('empty answer')
    return Response.json({ answer: text }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    // The page keeps its offline responses, so a failure here degrades rather
    // than breaking the feature.
    console.error('[oracle]', (err as Error).message)
    return Response.json({ error: 'unavailable' }, { status: 502 })
  }
}

export const config: Config = { path: '/api/oracle' }
