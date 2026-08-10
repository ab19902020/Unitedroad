// Serve each section with its own <head>.
//
// The sections have had real URLs since the router moved off hashes, but the
// document served at every one of them was the raw index.html — carrying the
// homepage's title, description and share image. Google renders JavaScript so it
// eventually sees the right title, but nothing else does: paste /news into
// WhatsApp, Slack, X or Facebook and the preview is the homepage. So is the
// title in a search result before the page is rendered.
//
// This is the same treatment article-page.mts already gives /article/:id —
// fetch the shell, replace the head, serve it. The app then boots and behaves
// exactly as before.

import type { Config } from '@netlify/functions'
import { injectHead } from '../lib/seo.mts'

const SITE = 'https://unitedroad.uk'
const OG_IMAGE = `${SITE}/assets/old-trafford.svg`

// Kept in step with the `meta` map in Index.html, which handles the same job
// after a client-side navigation the server never sees. If you change one,
// change the other — they describe the same pages.
const SECTIONS: Record<string, [string, string]> = {
  '/news': ['Latest Man Utd News & Transfer Updates | United Road',
    'The latest Manchester United news, written in-house. Squad, injuries, ownership and the stories that matter, updated through the day.'],
  '/articles': ['Original Manchester United Blog & Articles | United Road',
    'Long-form Manchester United analysis and opinion, written for United Road. The argument behind the headline.'],
  '/transfers': ['LIVE: Transfer Strategy | United Road',
    'Live Manchester United transfer news and rumours, tracked as they break, with our read on what is real and what is noise.'],
  '/academy': ['Academy Watch & Next Gen | United Road',
    'Manchester United academy news: the next generation coming through Carrington, and who is close to the first team.'],
  '/matchday': ['Man Utd Fixtures, Results & Table | United Road',
    'Manchester United fixtures, results and the current Premier League table, plus the build-up and reaction to every match.'],
  '/hub': ['Manchester United Social Hub & Fan Channels | United Road',
    'The best Manchester United fan channels in one place, including Stretford Paddock and Stephen Howson. Latest uploads and reaction.'],
  '/vault': ['Take Me Home United Road Lyrics & Chants | United Road',
    'Every Manchester United chant with full lyrics, from Take Me Home United Road to the terrace classics.'],
  '/videos': ['Videos & Movies | United Road',
    'Manchester United video archive: classic matches, documentaries, goals and fan films, gathered in one place.'],
  '/oracle': ['The United Oracle — Ask About Man Utd History | United Road',
    'Ask anything about Manchester United history: Busby, Munich, the treble, Ferguson, the Class of ’92.'],
  '/games': ['Man Utd Arcade & Web Games | United Road',
    'Free Manchester United games to play in your browser. Arcade football, quizzes and the Red Devil Manager save.'],
  '/manager': ['Red Devil Manager 26/27 | Man Utd Football Manager Game | United Road',
    'Take charge of Manchester United for the 26/27 season. Pick the team, work the transfer market and see if you can do better.'],
  '/about': ['About United Road | Fan Hub',
    'United Road is an independent Manchester United site, not affiliated with the club. Here is what we do and why.'],
  '/author': ['Adam James — Founder & Editor | United Road',
    'Adam James founded and edits United Road. Read about who writes the site and get in touch.'],
  '/standards': ['Editorial Standards | United Road',
    'How United Road separates fact from speculation, handles opinion, and corrects mistakes.'],
  '/contact': ['Contact Us | United Road',
    'Get in touch with United Road about the site, advertising, a correction, or to submit a chant.'],
  '/privacy': ['Privacy Policy | United Road', 'How United Road handles your data.'],
  '/terms': ['Terms of Service | United Road', 'The terms covering use of United Road.'],
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

let cachedShell: { html: string; at: number } | null = null
const SHELL_TTL = 5 * 60 * 1000

const loadShell = async (origin: string): Promise<string | null> => {
  if (cachedShell && Date.now() - cachedShell.at < SHELL_TTL) return cachedShell.html
  try {
    const res = await fetch(`${origin}/index.html?__shell=1`)
    if (!res.ok) return null
    const html = await res.text()
    cachedShell = { html, at: Date.now() }
    return html
  } catch {
    return null
  }
}

export default async (req: Request) => {
  const path = new URL(req.url).pathname.replace(/\/+$/, '') || '/'
  const entry = SECTIONS[path]
  const origin = process.env.URL || process.env.DEPLOY_PRIME_URL || new URL(req.url).origin

  const shell = await loadShell(origin)
  // Without the shell there is nothing to rewrite. Serving the plain file is a
  // page with the wrong title, which beats a 500.
  if (!shell || !entry) {
    return new Response(null, { status: 302, headers: { Location: '/index.html' } })
  }

  const [title, description] = entry
  const url = `${SITE}${path}`
  const head = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}">`,
    `<link rel="canonical" href="${url}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="United Road">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="${OG_IMAGE}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(description)}">`,
    `<meta name="twitter:image" content="${OG_IMAGE}">`,
  ].join('\n')

  return new Response(injectHead(shell, head), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600',
    },
  })
}

export const config: Config = { path: Object.keys(SECTIONS) as any }
