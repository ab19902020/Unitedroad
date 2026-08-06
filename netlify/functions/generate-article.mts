// Daily cron for the United Road AI article desk.
//
// Netlify caps scheduled functions at 30 seconds, which is not enough to fetch
// a dozen feeds and wait on DeepSeek to write 700 words. So this function does
// almost nothing itself: it hands the job to the background worker
// (article-desk.mts, 15 minute limit) and returns.
//
// Site environment variables:
//   DEEPSEEK_API_KEY      required — the DeepSeek key, server-side only
//   ARTICLE_WRITER_TOKEN  strongly recommended — shared secret used to call the
//                         background worker, and to protect it from the public
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

  if (token && siteUrl) {
    try {
      const res = await fetch(`${siteUrl}/.netlify/functions/article-desk-background`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'cron' }),
      })
      console.log(`[article-desk] cron handed off to the background worker (${res.status}).`)
      return json({ status: 'dispatched', workerStatus: res.status })
    } catch (err) {
      console.error('[article-desk] handoff failed, running inline instead:', (err as Error).message)
    }
  } else {
    console.warn(
      '[article-desk] ARTICLE_WRITER_TOKEN is not set, so the run happens inline and may hit the 30s scheduled-function limit. Set the token to move the work to the background worker.',
    )
  }

  // Inline fallback. Works, but a long generation can be cut off by the 30
  // second ceiling — hence the warning above.
  try {
    const result = await runArticleGeneration()
    console.log(
      result.status === 'published'
        ? `[article-desk] published inline: "${result.article.title}"`
        : `[article-desk] skipped: ${result.reason}`,
    )
    return json(result)
  } catch (err) {
    console.error('[article-desk] inline run failed:', (err as Error).message)
    return json({ status: 'error', message: (err as Error).message }, 500)
  }
}

// 07:15 UTC daily — late enough that overnight reporting has landed, early
// enough to be there for the morning read.
export const config: Config = {
  schedule: '15 7 * * *',
}
