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

The site publishes its own articles automatically. Once a day a Netlify
function reads the same Manchester United feeds the news and transfer pages
use, hands the day's stories to DeepSeek with the United Road editorial
"brain", and stores the finished piece in Netlify Blobs. The `/articles` page
merges those with the Substack posts into one timeline; AI-written pieces carry
an **AI Desk** badge, a note explaining how they were produced, and a list of
the reporting they were written from.

### Setup

Set these on the site (**Netlify → Site configuration → Environment variables**).
The DeepSeek key is only ever read server-side and is never sent to the browser.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | yes | Your DeepSeek API key. |
| `ARTICLE_WRITER_TOKEN` | yes | Any long random string you invent. Protects the writer endpoint and lets the daily cron reach the background worker. |
| `DEEPSEEK_MODEL` | no | Defaults to `deepseek-v4-flash`. Set to `deepseek-v4-pro` for longer, more considered pieces at roughly 3× the cost. |

Both are required. A measured end-to-end generation takes **around 53 seconds**
(most of it DeepSeek reasoning), and Netlify kills scheduled functions at 30,
so the cron cannot do the work itself — it hands off to a background function,
and `ARTICLE_WRITER_TOKEN` is how it authenticates that call. Without the token
the daily job logs an error and skips rather than paying for a generation that
would be thrown away.

Cost per article is roughly **$0.002** on `deepseek-v4-flash` (~4k prompt
tokens, most of them cache hits, and ~6.5k output tokens including reasoning).

### How it runs

- **Daily** — `netlify/functions/generate-article.mts` fires at 07:15 UTC and
  hands the job to the background worker.
- **On demand** — post to the worker yourself:

  ```bash
  curl -X POST https://unitedroad.uk/.netlify/functions/article-desk-background \
       -H "Authorization: Bearer $ARTICLE_WRITER_TOKEN" \
       -H "Content-Type: application/json" \
       -d '{"angle":"transfer","force":true}'
  ```

  `angle` is one of `transfer`, `analysis`, `roundup`, `squad` (the cron rotates
  through them by day). `force` bypasses the one-article-per-day guard.
  Background functions answer `202` straight away, so check `/api/articles` or
  the function log for the result.

### Tuning the voice

The editorial identity lives in `netlify/lib/brain.mts` — voice, the rules about
what it may and may not assert, the HTML it is allowed to emit, and the four
rotating angles. That is the file to edit to change how the desk writes.

Two rules in there matter more than the rest, and are deliberately repeated in
the prompt: **only state what appears in the supplied source material**, and
**never invent a quote, fee, scoreline or date**. An automated desk that
hallucinates a transfer is worse than one that publishes nothing, so the
pipeline also fails closed — if fewer than three uncovered stories are
available, or the model returns under 180 words, nothing is published.

Everything the model returns is sanitised before it is stored
(`sanitizeHtml` in `netlify/lib/article-writer.mts`): only a small tag
allowlist survives, all attributes are dropped except plain `http(s)` hrefs,
and scripts, iframes, inline styles and event handlers are stripped.

### Files

| Path | What it does |
| --- | --- |
| `netlify/lib/brain.mts` | The editorial identity and the rotating angles. |
| `netlify/lib/article-writer.mts` | Source gathering, the DeepSeek call, sanitising, storage. |
| `netlify/lib/feed.mts` | Dependency-free RSS/Atom parsing. |
| `netlify/functions/generate-article.mts` | The daily cron. |
| `netlify/functions/article-desk-background.mts` | The worker that does the writing. |
| `netlify/functions/articles.mts` | `GET /api/articles` — serves the stored pieces to the site. |

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
