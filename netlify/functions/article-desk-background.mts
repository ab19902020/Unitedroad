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
//        -d '{"angle":"transfer","force":true}'
//
// Background functions answer 202 immediately and finish the work afterwards,
// so the response tells you the run started, not what it produced. Check
// /api/articles or the function log for the result.
//
// Because a public URL that spends money on every hit would be an obvious
// thing to abuse, the endpoint is closed unless ARTICLE_WRITER_TOKEN is set
// and the caller presents it.

import { runArticleGeneration } from '../lib/article-writer.mts'

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
    const result = await runArticleGeneration({
      angleId: typeof body?.angle === 'string' ? body.angle : undefined,
      force: body?.force === true,
    })

    if (result.status === 'published') {
      console.log(
        `[article-desk] published "${result.article.title}" (${result.article.angle}, ${result.article.readMinutes} min read) from ${result.sourcesConsidered} candidate stories in ${Date.now() - startedAt}ms`,
      )
    } else {
      console.log(`[article-desk] skipped: ${result.reason}`)
    }

    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } })
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
