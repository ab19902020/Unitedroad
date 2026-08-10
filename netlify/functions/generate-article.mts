// Daily cron for the United Road AI article desk.
//
// Netlify caps scheduled functions at 30 seconds. A measured run takes around
// 53 seconds *per article* — fetching a dozen feeds, then waiting on DeepSeek
// to reason and write ~600 words — and the desk writes up to three a day, so
// doing the work here is not an option. This function does almost nothing
// itself: it hands the job to the background worker
// (article-desk-background.mts, 15 minute limit) and returns.
//
// Site environment variables:
//   DEEPSEEK_API_KEY      required — the DeepSeek key, server-side only
//   ARTICLE_WRITER_TOKEN  optional — shared secret used to call the background
//                         worker. Falls back to Netlify's SITE_ID, so in
//                         practice nothing needs setting here
//   DEEPSEEK_MODEL        optional — defaults to deepseek-v4-flash

import type { Config, Context } from '@netlify/functions'
import { getWorkerAuth } from '../lib/worker-auth.mts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export default async (_req: Request, context: Context) => {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.warn('[article-desk] cron skipped: DEEPSEEK_API_KEY is not set on this site.')
    return json({ status: 'skipped', reason: 'DEEPSEEK_API_KEY is not set.' })
  }

  const auth = getWorkerAuth(context?.site?.id)
  const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL

  // Deliberately no inline fallback. A run takes roughly 20-30 seconds per
  // article and this function is killed at 30, so running it here would
  // reliably pay DeepSeek for a result that is thrown away. Better to do
  // nothing and say loudly why.
  if (auth.mode === 'none') {
    console.error(
      '[article-desk] cron skipped: no shared secret available. Netlify normally provides SITE_ID automatically; if it is missing, set ARTICLE_WRITER_TOKEN in Site configuration → Environment variables.',
    )
    return json({ status: 'skipped', reason: 'No worker secret available.' })
  }

  if (!siteUrl) {
    console.error('[article-desk] cron skipped: neither URL nor DEPLOY_PRIME_URL is available.')
    return json({ status: 'skipped', reason: 'Site URL unavailable.' })
  }

  try {
    const res = await fetch(`${siteUrl}/.netlify/functions/article-desk-background`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'cron' }),
    })
    // Netlify answers 202 the moment it accepts the request, before the
    // worker's own auth check runs — so 202 means "handed over", not "wrote an
    // article", and anything else means the handoff itself failed.
    // /api/desk-status reports what the run actually did.
    if (res.status !== 202) {
      console.error(`[article-desk] worker handoff returned ${res.status}, expected 202.`)
      return json({ status: 'error', reason: `Worker returned ${res.status}.` }, 502)
    }
    console.log(`[article-desk] cron handed off to the background worker (auth: ${auth.mode}).`)

    const now = new Date()

    // Once a day, re-establish what is currently true at the club from live
    // reporting. Everything the desk writes that day is prompted with it, so a
    // stale fact — a manager who left months ago — cannot reach an article.
    if (now.getUTCHours() === 5 && now.getUTCMinutes() < 5) {
      fetch(`${siteUrl}/api/refresh-club-state?refresh=1`, { method: 'POST' })
        .catch((e) => console.error('[club-state] refresh failed:', e.message))
    }

    // Sunday evening: also kick the weekly round-up. It no-ops if one has
    // already gone out this week, so firing it on every Sunday run is safe.
    if (now.getUTCDay() === 0 && now.getUTCHours() === 18) {
      fetch(`${siteUrl}/.netlify/functions/weekly-roundup`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth.secret}` },
      }).catch((e) => console.error('[weekly-roundup] handoff failed:', e.message))
    }

    return json({ status: 'dispatched' })
  } catch (err) {
    console.error('[article-desk] handoff failed:', (err as Error).message)
    return json({ status: 'error', message: (err as Error).message }, 500)
  }
}

// Every five minutes, so a story that breaks is published within minutes
// rather than waiting for a daily slot.
//
// This is a poll, not a write cycle. The overwhelming majority of runs fetch
// the feeds, find nothing that has not already been covered, and return without
// calling DeepSeek at all — cost tracks stories that actually broke, not clock
// ticks. The daily ceilings in runDailyBatch (10 news, 3 articles) are what
// bound the output.
export const config: Config = {
  schedule: '*/5 * * * *',
}
