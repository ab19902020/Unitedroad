// The worker that actually writes an article.
//
// This is a *background* function (15 minute limit) rather than a plain one,
// because fetching a dozen feeds and then waiting on DeepSeek to write 700
// words comfortably exceeds the 30 second ceiling Netlify puts on scheduled
// and regular functions.
//
// The `-background` filename suffix is what makes it a background function, so
// this file must keep that name.
//
// It is the single entry point for both the daily cron (generate-article.mts
// calls it) and any manual run:
//
//   curl -X POST https://unitedroad.uk/.netlify/functions/article-desk-background \
//        -H "Authorization: Bearer $ARTICLE_WRITER_TOKEN" \
//        -H "Content-Type: application/json" \
//        -d '{"max":3,"force":true}'
//
// Background functions answer 202 immediately and finish the work afterwards,
// so the response tells you the run started, not what it produced. Check
// /api/articles or the function log for the result.
//
// Because a public URL that spends money on every hit would be an obvious
// thing to abuse, the endpoint is closed unless ARTICLE_WRITER_TOKEN is set
// and the caller presents it.

import { runDailyBatch } from '../lib/article-writer.mts'

export default async (req: Request) => {
  const expected = process.env.ARTICLE_WRITER_TOKEN
  if (!expected) {
    console.warn('[article-desk] refused: ARTICLE_WRITER_TOKEN is not set on this site.')
    return new Response('ARTICLE_WRITER_TOKEN is not configured.', { status: 503 })
  }

  const presented = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
  if (!presented || presented !== expected) {
    return new Response('Unauthorized.', { status: 401 })
  }

  let body: any = {}
  try {
    body = await req.json()
  } catch {
    // No body is fine — everything is optional.
  }

  const startedAt = Date.now()
  try {
    const result = await runDailyBatch({
      max: Number.isFinite(body?.max) ? Number(body.max) : undefined,
      force: body?.force === true,
    })

    const seconds = Math.round((Date.now() - startedAt) / 1000)
    if (result.published.length) {
      console.log(
        `[article-desk] published ${result.published.length} article(s) in ${seconds}s from ${result.storiesAvailable} available stories:`,
      )
      result.published.forEach((a) => console.log(`  • ${a.title} (${a.shape}/${a.tone}, ${a.readMinutes} min)`))
    } else {
      console.log(`[article-desk] published nothing (${result.status}) after ${seconds}s.`)
    }
    // The notes explain every story that was considered and skipped, which is
    // the first thing worth reading when a run produces less than expected.
    result.notes.forEach((n) => console.log(`  - ${n}`))

    // Keep the response light: the articles themselves are already stored.
    return new Response(
      JSON.stringify({
        status: result.status,
        publishedCount: result.published.length,
        titles: result.published.map((a) => a.title),
        storiesAvailable: result.storiesAvailable,
        notes: result.notes,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  } catch (err) {
    // Netlify retries failed background invocations twice. A DeepSeek outage is
    // worth retrying; a bad prompt is not, and each retry costs a call — so
    // swallow the error and let tomorrow's run try again.
    console.error('[article-desk] run failed:', (err as Error).message)
    return new Response(JSON.stringify({ status: 'error', message: (err as Error).message }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
