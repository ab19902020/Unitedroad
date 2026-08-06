// Health check for the AI article desk: GET https://unitedroad.uk/api/desk-status
//
// This exists because a background function tells you nothing. Netlify answers
// 202 the instant it accepts the request — before the handler runs — so a curl
// against the worker looks identical whether it wrote three articles, was
// refused for a bad token, or crashed on the first line. Without this endpoint
// the only way to find out was to dig through the Netlify function logs.
//
// It reports whether the environment variables are present as booleans only.
// It never returns their values.

import type { Config } from '@netlify/functions'
import { readStatus } from '../lib/article-writer.mts'

const ago = (ts: number | null | undefined): string | null => {
  if (!ts) return null
  const mins = Math.floor((Date.now() - ts) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

export default async () => {
  const s = await readStatus()

  // Work out the single most useful sentence to show first, so the answer to
  // "why are there no articles?" is at the top rather than inferred.
  let diagnosis: string
  if (!s.deepseekKeySet) {
    diagnosis = 'DEEPSEEK_API_KEY is not set on this deploy. Add it in Site configuration → Environment variables, then redeploy — variables only reach functions on a fresh build.'
  } else if (!s.writerTokenSet) {
    diagnosis = 'ARTICLE_WRITER_TOKEN is not set on this deploy. The daily cron needs it to reach the background worker. Add it, then redeploy.'
  } else if (s.articleCount > 0) {
    diagnosis = `Working. ${s.articleCount} article(s) stored, most recent ${ago(s.latestArticle?.at)}.`
  } else if (s.lastRun) {
    diagnosis = `Both variables are set and the desk ran ${ago(s.lastRun.at)}, but published nothing. See lastRun.notes below for the reason.`
  } else if (s.lastRejectedAt) {
    diagnosis = `Both variables are set, but the last call to the worker was rejected ${ago(s.lastRejectedAt)} because the token did not match. Check the token in your request against ARTICLE_WRITER_TOKEN.`
  } else {
    diagnosis = 'Both variables are set, but the desk has never run on this deploy. Either wait for the next scheduled run, or trigger one manually (see README).'
  }

  return Response.json(
    {
      status: 'ok',
      diagnosis,
      config: {
        deepseekKeySet: s.deepseekKeySet,
        writerTokenSet: s.writerTokenSet,
        model: s.model,
        schedule: '07:15 and 16:15 UTC daily',
      },
      articles: {
        stored: s.articleCount,
        latest: s.latestArticle
          ? { title: s.latestArticle.title, published: ago(s.latestArticle.at) }
          : null,
      },
      lastRun: s.lastRun
        ? { ...s.lastRun, when: ago(s.lastRun.at), durationSeconds: Math.round(s.lastRun.durationMs / 1000) }
        : null,
      lastRejectedCall: s.lastRejectedAt ? ago(s.lastRejectedAt) : null,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

export const config: Config = {
  path: '/api/desk-status',
}
