// Shared secret between the daily cron and the background worker.
//
// The worker spends DeepSeek credit, so it cannot be an open endpoint. But
// requiring the owner to invent and set ARTICLE_WRITER_TOKEN turned out to be
// the single thing that stopped the desk working — the key was set, the token
// was not, and because a background function always answers 202 there was no
// visible symptom.
//
// So the token is now optional. If it is absent we fall back to SITE_ID, which
// Netlify injects into both functions automatically: the cron and the worker
// run on the same site, so they derive the same secret with no configuration.
// A site ID is a UUID that does not appear anywhere on the public site, and the
// worst an attacker could do with one is make the desk write an article it was
// going to write anyway — runDailyBatch caps the day at three regardless. That
// is a fair trade for removing a setup step that silently broke the feature.

export type WorkerAuth =
  | { mode: 'token' | 'site-id'; secret: string }
  | { mode: 'none'; secret: null }

/**
 * @param contextSiteId `context.site.id` from the Functions v2 handler. This is
 *   the reliable source: Netlify's docs do not promise SITE_ID as a *runtime*
 *   environment variable (it is documented as a build variable), whereas the
 *   handler context always carries the site. The env var is kept only as a
 *   secondary fallback.
 */
export const getWorkerAuth = (contextSiteId?: string): WorkerAuth => {
  const token = process.env.ARTICLE_WRITER_TOKEN?.trim()
  if (token) return { mode: 'token', secret: token }

  const siteId = contextSiteId?.trim() || process.env.SITE_ID?.trim()
  if (siteId) return { mode: 'site-id', secret: siteId }

  return { mode: 'none', secret: null }
}

// Constant-time-ish comparison. Not a serious threat model here, but there is
// no reason to leak length or prefix information on a secret comparison.
export const secretMatches = (presented: string, expected: string): boolean => {
  if (presented.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < presented.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}
