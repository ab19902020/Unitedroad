// Read back what the desk has published and say honestly how it reads.
//
//   GET  /api/self-audit   the last report
//   POST /api/self-audit   run a new one
//
// An unattended writer drifts. Not by producing anything obviously broken —
// the copy checks and word floors catch that — but by settling into the same
// three sentence shapes, hedging every judgement into meaninglessness, or
// filling a quota with pieces that say nothing. None of that trips a rule,
// because none of it is a rule violation. It is a quality problem, and the only
// cheap way to see it is to read a stretch of output as a whole.
//
// So this reads the last twenty pieces together and reports on them. It changes
// nothing on its own; it tells the site owner what is going wrong so the briefs
// can be adjusted.

import type { Config } from '@netlify/functions'
import { getStore } from '@netlify/blobs'
import { readIndex, callDeepSeek } from '../lib/article-writer.mts'
import { stripTags } from '../lib/feed.mts'

const store = () => getStore({ name: 'united-road-articles', consistency: 'strong' })
const KEY = 'self-audit.json'

const SYSTEM = `You are a demanding editor reviewing a week of a football site's output. You are not here to be encouraging.

You will be given recent pieces: headline, standfirst, and the opening of the body. Read them as a body of work, not one at a time.

Report on:
- REPETITION. The same sentence constructions, the same openings, the same headline patterns, the same argument reached by the same route. Quote the actual repeats.
- HEDGING. Judgements qualified into saying nothing: "it remains to be seen", "only time will tell", "fans will be hoping". Quote them.
- FILLER. Pieces with no argument in them — that restate a headline for 400 words and stop. Name them.
- SAMENESS OF VIEW. Every piece landing on the same tone, positive or negative, regardless of subject.
- FACTUAL DRIFT. Anything asserted as current fact that reads like it came from memory rather than reporting — a manager, a squad member, a competition that may no longer be right.

Be specific and quote. "Some repetition" is useless. "Four of these open with 'In a summer that has already seen'" is useful.

If the work is genuinely fine in a category, say so briefly rather than inventing a problem.

Respond with a single JSON object and nothing else:
{
  "verdict": "one or two sentences, the honest overall read",
  "score": 0-10 for how varied and worthwhile this stretch of writing is,
  "issues": [{"kind":"repetition|hedging|filler|sameness|drift","detail":"what is wrong, with a quote","examples":["headline of an offending piece"]}],
  "briefChanges": ["Up to 3 concrete changes to the writing brief that would fix the biggest problems. Specific instructions, not aims."]
}`

export default async (req: Request) => {
  if (req.method === 'GET') {
    try {
      const last = await store().get(KEY, { type: 'json' })
      return Response.json(last || { status: 'none', note: 'No audit has run yet. POST here to run one.' },
        { headers: { 'Cache-Control': 'no-store' } })
    } catch {
      return Response.json({ status: 'none' })
    }
  }

  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) return Response.json({ error: 'DEEPSEEK_API_KEY is not set.' }, { status: 503 })

  const index = await readIndex()
  const recent = index.articles.slice(0, 20)
  if (recent.length < 6) {
    return Response.json({ status: 'skipped', reason: `Only ${recent.length} pieces published; too few to read as a body of work.` })
  }

  const material = recent
    .map((a, i) => `[${i + 1}] ${a.title}\n    ${a.standfirst || ''}\n    ${stripTags(a.content).slice(0, 420)}`)
    .join('\n\n')

  try {
    const parsed = await callDeepSeek(
      apiKey, process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash', SYSTEM, material,
    )
    const report = {
      status: 'ok',
      at: Date.now(),
      piecesReviewed: recent.length,
      verdict: String(parsed?.verdict || '').slice(0, 600),
      score: Math.max(0, Math.min(10, Number(parsed?.score) || 0)),
      issues: Array.isArray(parsed?.issues) ? parsed.issues.slice(0, 8) : [],
      briefChanges: Array.isArray(parsed?.briefChanges) ? parsed.briefChanges.slice(0, 3) : [],
    }
    await store().setJSON(KEY, report)
    console.log(`[self-audit] score ${report.score}/10 over ${report.piecesReviewed} pieces: ${report.verdict.slice(0, 120)}`)
    return Response.json(report, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return Response.json({ status: 'error', reason: (err as Error).message }, { status: 502 })
  }
}

export const config: Config = { path: '/api/self-audit' }
