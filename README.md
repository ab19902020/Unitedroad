# United Road - Manchester United Fan Site

![United Road Banner](https://unitedroad.uk/banner-image.jpg) <!-- Replace with your actual banner if you have one -->

**The ultimate destination for Manchester United fans** — dedicated to Old Trafford chants, songs, lyrics, matchday atmosphere, and fun web games.

[Visit the live site → unitedroad.uk](https://unitedroad.uk)

---

## About United Road

United Road is a passionate, independent fan project created for the Manchester United community. It focuses on preserving and celebrating the singing culture of Old Trafford through:

- Classic and modern Manchester United chants & songs with lyrics and audio
- The iconic **"Take Me Home, United Road"** chant
- Interactive web games
- Latest news and transfer rumours
- Matchday atmosphere content

---

## Games

The web arcade lives at `#/games`, driven by the `GAMES_LIBRARY` array in `Index.html`.

### Red Devil Manager 26/27 — featured

The Manchester United football manager game for the 2026/27 season: name your XI, drill the
tactics, work the transfer window and chase the title. It is the headline title on the site and
has its own deep link at **`#/manager`**, which boots straight into the game.

- Game source: [ab19902020/Manchester-United-manager-](https://github.com/ab19902020/Manchester-United-manager-)
- Cover art: `assets/games/manager-thumb.svg`

Other titles: United Rhythm, World Cup Free Kicks and the Ultimate United Quiz.

Each entry in `GAMES_LIBRARY` carries its own `accent`/`glow` colours plus `meta`
(session length, difficulty, mode) and `highlights`, which is what drives the
arcade tiles — the whole card is the play button, it tilts toward the cursor,
and the accent colour makes each title read as its own thing on the shelf.

This is **not** an official Manchester United website.

---

## The AI Article Desk

The site writes everything it publishes. **Every five minutes** a Netlify
function reads the Manchester United feeds, works out which stories are new,
and asks DeepSeek to write them up in the United Road house voice.

Two kinds of piece, with separate daily ceilings:

| Kind | Length | Per day | When |
| --- | --- | --- | --- |
| **News** | 250–400 words, two sections | up to 10 | As stories break |
| **Article** | 500–750 words, full house voice with a verdict | up to 3 | One per run at most, from the best-corroborated story |

Anything reported in the last 30 minutes is treated as urgent and goes out as a
news item straight away, so breaking stories appear within minutes rather than
waiting for a daily slot.

The five-minute schedule is a **poll, not a write cycle**. Almost every run
fetches the feeds, finds nothing uncovered, and returns without calling DeepSeek
at all — cost tracks stories that actually broke, not clock ticks.

Substack is no longer used. `/api/substack` still exists but nothing reads it.

The news and transfer pages lead with this coverage rather than republishing
other outlets' headlines. External items only backfill underneath, and any that
the desk has already written up are filtered out so a story never appears twice.
Set `BACKFILL_WITH_FEEDS` to `false` in `Index.html` to drop the external items
entirely once the archive is deep enough to stand alone.

A measured full run writes ten articles in about three minutes. Finished pieces
are stored in Netlify Blobs and appear on `/articles`, `/news` and `/transfers`
under the byline **Adam James**, with the
reporting they were written from listed at the bottom.

Nothing on the site states how an article was produced.

On a quiet day it writes one. On a dead day it writes nothing. Publishing filler
is worse than publishing nothing, so the desk is never obliged to fill a quota.

---

### Step by step: switching it on in Netlify

**1. Get a DeepSeek API key**

Sign in at [platform.deepseek.com](https://platform.deepseek.com), go to **API
Keys → Create new API key**, and copy it. You only see it once. Make sure the
account has credit on it — the desk cannot write without it.

**2. Optionally, invent a writer token**

Only needed if you want to trigger runs by hand. Any long random string:

```bash
openssl rand -hex 24
```

Skip this and the desk still runs on schedule — it falls back to the site's own
ID as the internal secret between the cron and the worker.

**3. Add to Netlify**

In the Netlify dashboard, open the United Road site, then:

**Site configuration → Environment variables → Add a variable → Add a single
variable.**

Add these one at a time. Leave the scope as **All scopes** and the context as
**All deploy contexts**.

| Key | Value |
| --- | --- |
| `DEEPSEEK_API_KEY` | the key from step 1 — **required** |
| `ARTICLE_WRITER_TOKEN` | the random string from step 2 — optional |

Optionally also add `DEEPSEEK_MODEL` with the value `deepseek-v4-pro` if you
ever want longer, more considered pieces — it costs roughly 3× more. Leave it
out to use `deepseek-v4-flash`, which is what the desk is tuned for.

**What the Oracle costs you**

The Oracle answers visitors' questions with DeepSeek, so anyone who can reach
the site can spend your credit. It is capped at **10p a day** across all
visitors. Past that it falls back to the built-in offline answers, so the
feature degrades rather than breaking, and the cap resets at midnight UTC.

The cap is metered on the token counts DeepSeek reports, not on a guess at how
many questions is about right. A measured answer costs around **0.0066p**, so
10p is roughly **1,500 questions a day** — far more than the site will see.
Identical questions are cached for a week and cost nothing at all, and one
visitor is limited to 15 questions an hour so they cannot burn the day alone.

`GET /api/desk-status` reports the day's spend under `oracle`. To change the
budget, set `ORACLE_DAILY_PENCE` (e.g. `25` for 25p, `2` to keep it tighter).

**4. Deploy**

Environment variables only reach the functions on a fresh build, so trigger one:
**Deploys → Trigger deploy → Clear cache and deploy site.** Wait for it to go
green.

**5. Check the functions registered**

Go to **Logs → Functions.** You should see `generate-article`,
`article-desk-background`, `articles`, `desk-status`, `rss` and `substack`. If
`article-desk-background` is missing, the deploy did not pick up the new files —
re-run step 4.

**6. Check it is wired up**

Open this in a browser:

```
https://unitedroad.uk/api/desk-status
```

The `diagnosis` field at the top tells you in one sentence what is wrong, or
that it is working. Check this **before** anything else — it is the only place
that reports the truth (see the warning below).

**7. Write the first articles now, without waiting for the cron**

```bash
curl -X POST https://unitedroad.uk/.netlify/functions/article-desk-background \
     -H "Authorization: Bearer YOUR_TOKEN_OR_SITE_ID" \
     -H "Content-Type: application/json" \
     -d '{"force":true}'
```

> **The `202` you get back is meaningless.** Netlify answers `202 Accepted` the
> instant it accepts the request, *before* your function runs. You get the same
> `202` whether it wrote three articles, was refused for a wrong token, or
> crashed on the first line. Never treat it as success. Wait a minute, then
> reload `/api/desk-status` — that is where the real outcome is recorded.

Once it reports articles stored, open `https://unitedroad.uk/#/articles`.

If you did not set `ARTICLE_WRITER_TOKEN`, use your **Site ID** as the bearer
value instead — Netlify dashboard → **Site configuration → General → Site
information → Site ID**.

**That is it.** From then on it runs by itself at **07:15 and 16:15 UTC**, every
day, with no prompting. The morning run catches the overnight reporting; the
afternoon run picks up whatever broke during the day. The twenty-a-day ceiling
applies across both, so the second run tops the day up rather than doubling it.

---

### Options on the manual trigger

```bash
-d '{"force":true}'       # ignore the per-day cap
-d '{"max":1}'            # write at most one this run
-d '{"max":10,"force":true}'
```

### Timing and cost

Each article takes roughly 15–20 seconds end to end; a full ten-article run
measured 167 seconds across 18 API calls, well inside the worker's 15 minute
limit. Cost is around **$0.002 per article** on `deepseek-v4-flash`. At the twenty-a-day
ceiling that is roughly **$25 a year**; a normal day costs less, because the desk
only writes what there is genuine news for.

**No RSS API key is needed.** Feeds are fetched by the site's own Netlify proxy
(`netlify/functions/rss.mts`), so there is no third-party quota to exhaust. An
rss2json key was removed earlier precisely because it had to sit in the page
source, where every visitor could read it and the free tier was burned in
minutes by the site's own polling.

The work happens in a *background* function because Netlify kills scheduled
functions at 30 seconds. The daily cron does nothing but hand the job over,
which is authenticated with `ARTICLE_WRITER_TOKEN` when set, and otherwise with
the site's own ID.

---

### How the desk decides what to write about

1. **Fetch** twenty-one United feeds — the club, the national press, the
   fanzones — plus five Google News searches covering United generally and
   Fabrizio Romano, David Ornstein, transfers and injuries specifically.
2. **Filter** out anything that is not about United, plus live blogs, quizzes
   and betting content.
3. **Cluster** by headline similarity, so one transfer covered by five outlets
   counts as *one* story and the desk gets all five accounts of it.
4. **Rank** by corroboration — a story carried by four outlets outranks one
   carried by a single blog — then by recency.
5. **Skip** anything it has already published about (it remembers the last 120
   headlines).
6. **Write** the top stories, one at a time, telling each one what the others in
   the run already covered so two articles never overlap.

### Rewriting, not copying

This was the hard part. Left alone, the model follows a source sentence by
sentence and swaps a few words, which is copying however you dress it up.

Two things stop it. The prompt in `netlify/lib/brain.mts` opens with a worked
example of the failure — a real source paragraph, the bad near-copy, and the
good rewrite — and tells the writer to start somewhere other than where the
source starts. Then every finished draft is checked against its sources for any
run of **12 identical consecutive words**. If one is found, the draft is
rejected and re-requested *with the offending phrases quoted back*, which fixes
it far more often than starting again on a different story. A draft that still
copies after that retry is thrown away and the story is skipped.

The 12-word window was measured, not guessed: against a genuinely rewritten
article, a 6-word window flagged 11 phrases and an 8-word window flagged 2 — all
of them unavoidable factual phrasing like *"on last year's third place finish"*.
At 10 words and above, nothing. Twelve is where a shared run stops being a
coincidence.

### Tuning the voice

`netlify/lib/brain.mts` is the only file that knows anything about how the desk
writes. It was reverse-engineered from the Substack archive: Title Case
headlines, a factual opening then named `<h2>` sections, the
`Latest Developments` → `My View on…` → `What Happens Next?` skeleton for news,
`we/us/our` for the club, `I` only in the verdict section, short paragraphs and a
firm closing line.

It also carries the two rules that matter most, repeated deliberately: **only
state what appears in the supplied source material**, and **never invent a
quote, fee, scoreline or date**. The pipeline fails closed to back this up — no
uncovered stories means no articles, and a draft under 220 words is rejected.

To change how it writes, edit that file. Nothing else needs touching.

Everything the model returns is sanitised before storage (`sanitizeHtml` in
`netlify/lib/article-writer.mts`): a small tag allowlist, all attributes dropped
except plain `http(s)` hrefs, and scripts, iframes, inline styles and event
handlers stripped.

### Files

| Path | What it does |
| --- | --- |
| `netlify/lib/brain.mts` | The house voice, the article shapes, the batch size. |
| `netlify/lib/article-writer.mts` | Feeds, clustering, the DeepSeek call, the copy check, storage. |
| `netlify/lib/feed.mts` | Dependency-free RSS/Atom parsing. |
| `netlify/functions/generate-article.mts` | The 07:15 and 16:15 UTC cron. Hands off and returns. |
| `netlify/functions/article-desk-background.mts` | The worker that does the writing. |
| `netlify/functions/articles.mts` | `GET /api/articles` — serves the stored pieces to the site. |
| `netlify/functions/desk-status.mts` | `GET /api/desk-status` — what the desk last did, and why. |

### If something goes wrong

**Always start at `https://unitedroad.uk/api/desk-status`.** Its `diagnosis`
field names the problem directly. The table below is what each answer means.

| `diagnosis` says | What to do |
| --- | --- |
| `DEEPSEEK_API_KEY is not set` | Add the variable, then **redeploy**. Variables only reach functions on a fresh build — adding one to an existing deploy does nothing. |
| `ARTICLE_WRITER_TOKEN is not set` | Same: add it, then redeploy. |
| `the last call to the worker was rejected` | Your token is set on the site but the one in your `curl` does not match it. Copy it again from Netlify. |
| `ran ... but published nothing` | Read `lastRun.notes` in the same response. Usually `nothing-to-write`, which is normal on a quiet day. |
| `has never run on this deploy` | The cron has not come round yet. Trigger one manually, or wait for 07:15 / 16:15 UTC. |
| `Working.` | It is fine. Articles are on `/#/articles`. |

If `lastRun.error` mentions `DeepSeek responded 402`, the DeepSeek account is
out of credit. `429` means you have hit a rate limit — the next run will
recover on its own.

---


---

## Copyright & Intellectual Property

**© 2026 United Road. All Rights Reserved.**

The entire codebase, design, content (including but not limited to chants, lyrics, games, graphics, audio files, and text), and branding of United Road are the intellectual property of the owner.

### Restrictions
You are **not permitted** to:
- Copy, fork, clone, or duplicate this repository
- Redeploy the site (or any substantial part of it) on another domain
- Use the code, design, or content for commercial or non-commercial purposes
- Remove copyright notices or watermarks
- Modify and redistribute any part of this project

Any unauthorized use, reproduction, or distribution will be considered a violation of copyright and may result in legal action.

---

## License

This project is **not open source**. All rights are reserved. No license is granted for reuse, modification, or redistribution.

For permission to use any part of this project (code, content, design, or assets), please contact the owner.

---

## Legal Notice

This is a fan-made website created out of love for Manchester United Football Club. All trademarks, club badges, and official imagery belong to their respective owners (Manchester United FC, etc.). This site is not affiliated with, endorsed by, or connected to Manchester United Football Club.

---

## Deployment

This site is automatically deployed from GitHub to Netlify on every push to the main branch.

There is no build step. `netlify.toml` publishes the repository root as-is and
points Netlify at `netlify/functions`; `package.json` exists only so Netlify
installs the two packages the functions need (`@netlify/blobs`,
`@netlify/functions`).

### Images from feeds

Every remote image on the site comes from a source we do not control — YouTube
`maxresdefault` stills 404 for a large share of older uploads, publisher CDNs
hotlink-block, creator avatars rot. Rather than leaving broken-image icons
behind, `SmartImage` walks a chain of candidate URLs (for YouTube: maxres → sd →
hq → mq), treats YouTube's 120×90 grey filler as a failure, gives each candidate
a six-second deadline in case the host hangs instead of erroring, and finally
draws branded cover art as an inline SVG data URI. That last step needs no
network request, so it can never itself fail. `SmartAvatar` does the same for
profile pictures, falling back to an initials monogram.

The practical upshot: never add a stock-photo fallback URL to a feed mapper.
Leave the image empty and let the card generate its own cover.

---

## Contributing

Due to the copyright policy above, **we are not currently accepting contributions** (pull requests, code changes, etc.).

However, you are welcome to:
- Share the site with fellow United fans
- Suggest new chants or features (via social media)
- Report bugs or issues

---

## Connect With Us

- **TikTok**: [@unitedroad99](https://tiktok.com/@unitedroad99)
- **YouTube**: [@theunitedroad99](https://youtube.com/@theunitedroad99)
- **Website**: [unitedroad.uk](https://unitedroad.uk)

**GGMU** ❤️

---

## Thank You

Thank you for supporting this independent fan project.  
If you enjoy the chants and games, please share unitedroad.uk with other Red Devils!

---

*Last updated: August 2026*
