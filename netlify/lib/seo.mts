// Per-article <head> generation.
//
// The site is a single-page app. Everything it renders — including the title
// and description React sets on navigation — happens in the browser, after
// JavaScript runs. That is invisible to the crawlers that matter most:
//
//   - Facebook, X, WhatsApp, LinkedIn and Slack do not execute JavaScript at
//     all. Every share of every article was picking up the site-wide homepage
//     title, description and image.
//   - Google does render JavaScript, but only after a second pass, and it will
//     not treat "#/article/abc" as a distinct URL at all — fragments are never
//     sent to a server, so every article shared one indexable URL.
//
// So article pages are served through a function that injects a real <head>
// before the HTML leaves the server, on a real path. See article-page.mts.

import type { StoredArticle } from './article-writer.mts'

const SITE = 'https://unitedroad.uk'
const SITE_NAME = 'United Road'
const FALLBACK_IMAGE = `${SITE}/assets/old-trafford.svg`

const esc = (s: string): string =>
  String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const plain = (html: string): string =>
  String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

/** Absolute, canonical URL for a stored article. */
export const articleUrl = (id: string): string => `${SITE}/article/${encodeURIComponent(id)}`

/**
 * The <head> for one article: title, description, canonical, Open Graph,
 * Twitter card and NewsArticle structured data.
 */
export const articleHead = (a: StoredArticle): string => {
  const title = `${a.title} | ${SITE_NAME}`
  const description = (a.standfirst || a.excerpt || plain(a.content)).slice(0, 300)
  const url = articleUrl(a.id)
  const image = a.image && /^https?:\/\//i.test(a.image) ? a.image : FALLBACK_IMAGE
  const published = new Date(a.timestamp).toISOString()

  // Schema.org NewsArticle. Google uses this for Top Stories eligibility and
  // for the byline and date shown beside a result.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': a.kind === 'article' ? 'AnalysisNewsArticle' : 'NewsArticle',
    headline: a.title.slice(0, 110),
    description,
    image: [image],
    datePublished: published,
    dateModified: published,
    author: { '@type': 'Person', name: a.author },
    publisher: {
      '@type': 'Organization',
      name: SITE_NAME,
      url: SITE,
      logo: { '@type': 'ImageObject', url: 'https://iili.io/C2QPnkX.md.png' },
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    articleSection: a.category || 'Manchester United',
    keywords: ['Manchester United', ...(a.tags || [])].join(', '),
    isAccessibleForFree: true,
    inLanguage: 'en-GB',
  }

  return `
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}">
    <link rel="canonical" href="${esc(url)}">
    <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
    <meta property="og:type" content="article">
    <meta property="og:site_name" content="${esc(SITE_NAME)}">
    <meta property="og:url" content="${esc(url)}">
    <meta property="og:title" content="${esc(a.title)}">
    <meta property="og:description" content="${esc(description)}">
    <meta property="og:image" content="${esc(image)}">
    <meta property="article:published_time" content="${published}">
    <meta property="article:author" content="${esc(a.author)}">
    <meta property="article:section" content="${esc(a.category || 'News')}">
    ${(a.tags || []).map((t) => `<meta property="article:tag" content="${esc(t)}">`).join('\n    ')}
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(a.title)}">
    <meta name="twitter:description" content="${esc(description)}">
    <meta name="twitter:image" content="${esc(image)}">
    <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`
}

/**
 * Swap the static document's SEO tags for this article's.
 *
 * The shipped index.html carries the homepage's title, description, canonical
 * and og: tags. Leaving them in place alongside the article's would give
 * crawlers two of each and let them pick, so the originals are stripped first.
 */
export const injectHead = (html: string, head: string): string => {
  let out = html
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace(/<meta\s+id="meta-description"[^>]*>/i, '')
    .replace(/<meta\s+name="description"[^>]*>/i, '')
    .replace(/<link\s+rel="canonical"[^>]*>/i, '')
    .replace(/<meta\s+property="og:[^"]*"[^>]*>/gi, '')
    .replace(/<meta\s+name="twitter:[^"]*"[^>]*>/gi, '')
    .replace(/<meta\s+name="robots"[^>]*>/i, '')

  const close = out.search(/<\/head>/i)
  if (close === -1) return out
  return `${out.slice(0, close)}${head}\n${out.slice(close)}`
}
