// Re-pick cover photographs for pieces already published.
//
//   POST /api/refit-covers            fix the worst offenders
//   POST /api/refit-covers?all=1      re-examine everything
//
// The Commons matching rules changed after these were written — surname-only
// matching had put a photograph of David and Victoria Beckham on a story about
// Salford City — so the archive is carrying covers that today's rules would
// reject. New rules do not reach old articles on their own; this walks back
// through them.
//
// Deliberately conservative: it only ever *replaces* a cover it can prove is
// wrong, and only when it has something better. A piece it cannot improve is
// left exactly as it is.

import type { Config, Context } from '@netlify/functions'
import { readIndex, overwriteArticles, findCommonsImage, callDeepSeek } from '../lib/article-writer.mts'
import { getWorkerAuth, secretMatches } from '../lib/worker-auth.mts'

const BATCH_LIMIT = 24

export default async (req: Request, context: Context) => {
  const auth = getWorkerAuth(context?.site?.id)
  const supplied = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  if (auth.mode === 'none' || !secretMatches(supplied, auth.secret)) {
    return Response.json({ error: 'unauthorised' }, { status: 401 })
  }

  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) return Response.json({ error: 'DEEPSEEK_API_KEY is not set.' }, { status: 503 })
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash'

  const all = new URL(req.url).searchParams.has('all')
  const index = await readIndex()
  const articles = [...index.articles]

  // What counts as needing attention: no cover at all, or a cover shared with
  // another piece — the duplicate-photograph problem, which reads as broken.
  const counts = new Map<string, number>()
  for (const a of articles) if (a.image) counts.set(a.image, (counts.get(a.image) || 0) + 1)

  const suspect = articles.filter(
    (a) => !a.image || (a.image && counts.get(a.image)! > 1) || all,
  )
  if (!suspect.length) {
    return Response.json({ status: 'ok', examined: 0, changed: 0, note: 'Every piece already has its own cover.' })
  }

  const targets = suspect.slice(0, BATCH_LIMIT)

  // Older pieces predate the `people` field, so name the subject from the
  // headline. One call for the whole batch.
  const needNames = targets.filter((a) => !(a.people && a.people.length))
  const named = new Map<string, string[]>()
  if (needNames.length) {
    try {
      const parsed = await callDeepSeek(
        apiKey, model,
        `For each numbered Manchester United headline, name the one person the story is most about — the player, manager or executive a photograph should show.

Return null when the story is about the club rather than a person (finances, the stadium, a fixture, the league). A guess is worse than null: a wrong face on a story is the failure this is fixing.

Respond with a single JSON object: {"subjects":[{"n":1,"name":"Full Name"},{"n":2,"name":null}]}`,
        needNames.map((a, i) => `${i + 1}. ${a.title}`).join('\n'),
      )
      for (const row of parsed?.subjects || []) {
        const i = Number(row?.n) - 1
        const name = typeof row?.name === 'string' ? row.name.trim() : ''
        if (needNames[i] && name && name.toLowerCase() !== 'null') named.set(needNames[i].id, [name])
      }
    } catch (err) {
      console.warn('[refit-covers] naming failed:', (err as Error).message)
    }
  }

  // Every cover currently in use, so a replacement cannot introduce a new clash.
  const taken = new Set(articles.map((a) => a.image).filter(Boolean) as string[])
  const changed: { id: string; title: string; person: string }[] = []

  for (const a of targets) {
    const people = (a.people && a.people.length ? a.people : named.get(a.id)) || []
    for (const person of people) {
      const found = await findCommonsImage(person, taken)
      if (!found) continue
      if (a.image) taken.delete(a.image)
      taken.add(found.url)
      a.image = found.url
      a.imageCredit = `${found.credit} / ${found.licence}`
      changed.push({ id: a.id, title: a.title.slice(0, 70), person })
      break
    }
  }

  if (changed.length) await overwriteArticles(articles)

  return Response.json({
    status: 'ok',
    examined: targets.length,
    remaining: Math.max(0, suspect.length - targets.length),
    changed: changed.length,
    updated: changed,
    note: suspect.length > BATCH_LIMIT ? 'Run again to continue through the archive.' : undefined,
  })
}

export const config: Config = { path: '/api/refit-covers', method: 'POST' }
