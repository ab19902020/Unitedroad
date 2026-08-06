// Serves the articles written by the AI desk to the site.
//
// The page merges these with the Substack feed on /articles, so the shape here
// deliberately mirrors what /api/substack returns.

import type { Config } from '@netlify/functions'
import { readIndex } from '../lib/article-writer.mts'

export default async (req: Request) => {
  try {
    const limit = Math.min(
      120,
      Math.max(1, Number(new URL(req.url).searchParams.get('limit')) || 40),
    )

    const index = await readIndex()
    const items = index.articles.slice(0, limit)

    return Response.json(
      { status: 'ok', updatedAt: index.updatedAt, count: items.length, items },
      {
        // The desk publishes once a day, so a few minutes of shared CDN cache
        // costs nothing in freshness and saves a blob read per visitor.
        headers: { 'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=1800' },
      },
    )
  } catch (err) {
    // A site that has never run the writer has no blob store yet; that is not
    // an error worth showing the reader, so return an empty list.
    return Response.json(
      { status: 'ok', updatedAt: 0, count: 0, items: [], note: (err as Error).message },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  }
}

export const config: Config = {
  path: '/api/articles',
}
