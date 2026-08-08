// Sunday round-up, written from the site's own week rather than the wires.
//
// Runs as a background function because it makes a DeepSeek call; the cron in
// generate-article.mts cannot do it inside a 30 second scheduled slot.

import { readIndex, callDeepSeek, publishRoundup } from '../lib/article-writer.mts'
import { getWorkerAuth, secretMatches } from '../lib/worker-auth.mts'
import type { Context } from '@netlify/functions'

export default async (req: Request, context: Context) => {
  const auth = getWorkerAuth(context?.site?.id)
  if (auth.mode === 'none') return new Response('No secret configured.', { status: 503 })
  const presented = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
  if (!presented || !secretMatches(presented, auth.secret)) return new Response('Unauthorized.', { status: 401 })

  try {
    const result = await publishRoundup()
    console.log('[weekly-roundup]', result.status, result.title || result.reason || '')
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    console.error('[weekly-roundup] failed:', (err as Error).message)
    return new Response(JSON.stringify({ status: 'error', message: (err as Error).message }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
