// Daily cron for the United Road AI article desk.
//
// Netlify caps scheduled functions at 30 seconds. A measured end-to-end run —
// fetch a dozen feeds, then wait on DeepSeek to reason and write ~700 words —
// takes around 53 seconds, so doing the work here is not an option. This
// function does almost nothing itself: it hands the job to the background
// worker (article-desk-background.mts, 15 minute limit) and returns.
//
// Site environment variables:
//   DEEPSEEK_API_KEY      required — the DeepSeek key, server-side only
//   ARTICLE_WRITER_TOKEN  required — shared secret used to call the background
//                         worker, and to keep the public out of it
//   DEEPSEEK_MODEL        optional — defaults to deepseek-v4-flash

import type { Config } from '@netlify/functions'
import { runArticleGeneration } from '../lib/article-writer.mts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export default async () => {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.warn('[article-desk] cron skipped: DEEPSEEK_API_KEY is not set on this site.')
    return json({ status: 'skipped', reason: 'DEEPSEEK_API_KEY is not set.' })
  }

  const token = process.env.ARTICLE_WRITER_TOKEN
  const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL

  // Deliberately no inline fallback. A generation takes roughly 53 seconds and
  // this function is killed at 30, so running it here would reliably pay
  // DeepSeek for a result that is thrown away. Better to do nothing and say
  // loudly why.
  if (!token) {
    console.error(
      '[article-desk] cron skipped: ARTICLE_WRITER_TOKEN is not set. The daily run needs it to call the background worker — a generation takes ~53s and scheduled functions are capped at 30s. Set it in Site configuration → Environment variables.',
    )
    return json({ status: 'skipped', reason: 'ARTICLE_WRITER_TOKEN is not set.' })
  }

  if (!siteUrl) {
    console.error('[article-desk] cron skipped: neither URL nor DEPLOY_PRIME_URL is available.')
    return json({ status: 'skipped', reason: 'Site URL unavailable.' })
  }

  try {
    const res = await fetch(`${siteUrl}/.netlify/functions/article-desk-background`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'cron' }),
    })
    // A background function answers 202 immediately; anything else means the
    // handoff itself failed and no article is being written.
    if (res.status !== 202) {
      console.error(`[article-desk] worker handoff returned ${res.status}, expected 202.`)
      return json({ status: 'error', reason: `Worker returned ${res.status}.` }, 502)
    }
    console.log('[article-desk] cron handed off to the background worker.')
    return json({ status: 'dispatched' })
  } catch (err) {
    console.error('[article-desk] handoff failed:', (err as Error).message)
    return json({ status: 'error', message: (err as Error).message }, 500)
  }
}

// 07:15 UTC daily — late enough that overnight reporting has landed, early
// enough to be there for the morning read.
export const config: Config = {
  schedule: '15 7 * * *',
}
