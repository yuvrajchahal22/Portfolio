# yuvrajchahal — portfolio

Standard static site. No build step, no framework, no dependencies. Serve `site/` and it runs.

```
site/                       ← the website (deploy this folder)
  index.html                home — Jupiter hero, projects, contact
  about.html
  project-autocurve.html
  project-mecanum.html
  project-upsolve.html
  project-snake.html
  assets/css/site.css       design system (palette, type, layout, components)
  assets/js/site.js         scroll reveals, page-out fade, loads the planet after `load`
  assets/jupiter/           the planet: shader.js (GLSL), planet.js (WebGL), scroll.js (choreography)
  assets/favicon.svg
  uploads/YuvrajChahalResume.pdf

content/pages.json          every sentence on the site, extracted from the design source
Portfolio website redesign/ the Claude Design canvas files — design archive, not served
prototypes/                 the two evaluation demos (lensing grid, Jupiter)
legacy/                     the earlier generated site + converter; nothing here is used
JUPITER_HERO_BRIEF.md       the spec this was built to
```

## Run locally

```sh
cd site
python3 -m http.server 8000
# → http://127.0.0.1:8000/
```

Any static server works. Opening `index.html` from the filesystem does **not** — the
planet is an ES module and browsers refuse module imports over `file://`.

## Deploy

**Step-by-step instructions — GitHub, then Cloudflare Pages — are in [DEPLOY.md](DEPLOY.md).**
The summary:


Upload the contents of `site/` to any static host (GitHub Pages, Netlify, Cloudflare Pages,
Vercel). All paths are relative, so it works at a domain root or under a sub-path.

**Deploy exactly the contents of `site/` and nothing else.** The rest of this repo — the
design archive, `legacy/`, `prototypes/`, `content/` and the briefs — must not be published.

- **Netlify / Cloudflare Pages (recommended):** publish directory = `site`, no build command.
  Only that directory is uploaded. Both also read a `_headers` file placed inside it.
- **GitHub Pages:** branch-based Pages can only serve from `/` (root) or `/docs` — it cannot
  serve `site/`. Either rename `site/` to `docs/` and select `/docs`, or use a Pages GitHub
  Actions workflow with the `site` directory as the upload artifact. Note that GitHub Pages
  cannot set HTTP headers at all (no CSP, no HSTS); a `<meta http-equiv>` CSP is the only option.

## Things you will want to change

| What | Where |
| --- | --- |
| Resume PDF | replace `site/uploads/YuvrajChahalResume.pdf` (keep the name, or update the 8 links) |
| Portrait photo | `site/about.html` — the `.portrait` block has a placeholder; drop an `<img>` in it |
| Co-op availability text | the `.pill` in `site/index.html` and `site/about.html` |
| Email / LinkedIn | search `ysc27@sfu.ca` and `linkedin.com/in/yuvrajchahal` |
| Colours | `:root` tokens at the top of `site/assets/css/site.css` |
| Planet palette / lighting | `PALETTE` at the top of `site/assets/jupiter/shader.js` |
| Planet framing / scroll feel | `framing()` and the lerps in `site/assets/jupiter/scroll.js` |

## How the planet behaves

- Loads only after the page's `load` event, in idle time — it can never delay first paint.
- On boot it probes the GPU (never the user-agent) and picks a tier. Supersample is set by a
  **pixel budget** (`PIXEL_BUDGET` in `planet.js`), not a feedback loop — 8.5 Mpx per frame on
  tier `high`, which works out to 1.5× at 1× device pixels and ~1.28× at 2×, both holding a
  steady 60fps. The adaptive loop only ever steps *down*, as a safety net for slower GPUs, so
  quality can never visibly pulse. It re-derives the level on a resize.
- The static cloud turbulence is baked into a mipmapped equirectangular atlas (42.7 MB on
  `high`) **progressively — a time-budgeted slice per frame**, rendering procedurally at full
  quality until it is ready, so nothing blocks the first frames. The screen pass samples it while the
  animated parts (winds, warp drift, the Great Red Spot) stay procedural on top. That is
  what makes **60fps at 1.5× supersample** possible at both 1× and 2× device pixels.
  Only the disc's bounding box is shaded.
- Home page: as you scroll, a slow camera push onto the Great Red Spot across ~2.5 screens,
  the render defocuses (CSS blur) and drops to a cheap low-res draw that the blur hides.
- Every other page, phones, and `prefers-reduced-motion`: a single high-quality still frame,
  no animation loop. On phones the planet is centred above the headline.
- No WebGL: a CSS gradient in the same palette. JS off: page is fully readable, no planet.
- Diagnostics in the console: `__jupiter.stats` (tier, fps, supersample, probe results);
  force a tier with `?tier=low` on the URL.

Two shader constants worth knowing (`site/assets/jupiter/shader.js`): `SHEAR_TAU` (12) caps how
far the zonal winds can stretch cloud features (0 = unbounded, which turns everything into
lines after a minute); `PALETTE` is the planet's colour ramp.

## Copy

All text was carried over verbatim from the design files (`content/pages.json` is the
audit trail). The hero hook is the first line of the About page, promoted.

## Credits

Three GLSL routines in `site/assets/jupiter/shader.js` are borrowed, with thanks:

- **3D simplex noise** — Ashima Arts / Stefan Gustavson, MIT
  (<https://github.com/ashima/webgl-noise>)
- **`hash21` ("Hash without Sine")** — Dave Hoskins, MIT
  (<https://www.shadertoy.com/view/4djSRW>)
- **ACES filmic tonemap approximation** — Krzysztof Narkowicz
  (<https://knarkowicz.wordpress.com/2016/01/06/aces-filmic-tone-mapping-curve/>)

Type is Archivo (Omnibus-Type) and IBM Plex Mono (IBM), both SIL OFL 1.1, served via
Google Fonts. Everything else is original.
