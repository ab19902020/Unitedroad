// Re-derive what is currently true at Manchester United, from live reporting.
//
// GET/POST https://unitedroad.uk/api/refresh-club-state
//
// Runs daily on its own schedule. The facts it establishes are injected into
// every writing prompt, so this is what stops the desk naming a manager it
// remembers from training rather than the one in the job.

import type { Config } from '@netlify/functions'
import { refreshClubState, readClubState } from '../lib/article-writer.mts'

export default async (req: Request) => {
  // A plain GET reports what is currently held, without spending a call.
  if (req.method === 'GET' && !new URL(req.url).searchParams.has('refresh')) {
    return Response.json(await readClubState(), { headers: { 'Cache-Control': 'no-store' } })
  }
  const result = await refreshClubState()
  console.log('[club-state]', result.status, result.reason || result.state?.manager || '')
  return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
}

// Netlify allows a function a path or a schedule, not both, and being able to
// check and force a refresh by URL is worth more than a self-schedule. The cron
// in generate-article kicks this once a day, the same way it kicks the weekly
// round-up.
export const config: Config = {
  path: '/api/refresh-club-state',
}
