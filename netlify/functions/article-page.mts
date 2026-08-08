// Serves /article/:id with a real, article-specific <head>.
//
// This is what makes the site's own writing indexable and shareable. The SPA
// still renders the page in the browser exactly as before — this function only
// rewrites the document head on the way out, so a crawler that never runs
// JavaScript still sees the right title, description, image and structured
// data.

import type { Config, Context } from '@netlify/functions'
import { readIndex } from '../lib/article-writer.mts'
import { articleHead, injectHead } from '../lib/seo.mts'

// The shell is the same for every request, so hold it between invocations on a
// warm instance rather than re-fetching it each time.
let cachedShell: { html: string; at: number } | null = null
const SHELL_TTL = 5 * 60 * 1000

const loadShell = async (origin: string): Promise<string | null> => {
  if (cachedShell && Date.now() - cachedShell.at < SHELL_TTL) return cachedShell.html
  try {
    // ?__shell is a cache-buster only; the static file ignores query strings.
    const res = await fetch(`${origin}/index.html?__shell=1`)
    if (!res.ok) return null
    const html = await res.text()
    cachedShell = { html, at: Date.now() }
    return html
  } catch {
    return null
  }
}

export default async (req: Request, context: Context) => {
  const origin = process.env.URL || process.env.DEPLOY_PRIME_URL || new URL(req.url).origin
  const id = decodeURIComponent(context.params?.id || '')

  const shell = await loadShell(origin)
  // If the shell cannot be fetched, fall through to the static file rather than
  // erroring — a page with the wrong title beats no page at all.
  if (!shell) return new Response(null, { status: 302, headers: { Location: `/#/article/${id}` } })

  const index = await readIndex()
  const article = index.articles.find((a) => a.id === id)

  if (!article) {
    // Unknown id: let the SPA render its own not-found state, but tell crawlers
    // not to index it.
    const head = '<title>Article not found | United Road</title>\n<meta name="robots" content="noindex">'
    return new Response(injectHead(shell, head), {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }

  return new Response(injectHead(shell, articleHead(article)), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Articles do not change after publication, so let the CDN serve this.
      'Cache-Control': 'public, max-age=0, s-maxage=600, stale-while-revalidate=86400',
    },
  })
}

export const config: Config = {
  path: '/article/:id',
}
