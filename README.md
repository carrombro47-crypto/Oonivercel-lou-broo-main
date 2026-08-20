# PW Live Proxy — simple HLS player + download-playlist API

No login, no admin, no bot, no MongoDB, no file store. Fully stateless —
every route is driven only by the `?url=` query param you pass in. Next.js
14 App Router, deployed as a Docker container on Render.com.

## Repo structure

```
.
├── Dockerfile              # multi-stage build → Render Docker web service, PORT 8000
├── .dockerignore
├── .gitignore
├── next.config.mjs         # output: "standalone" (lean Docker image)
├── package.json
├── tsconfig.json
├── next-env.d.ts
├── app/
│   ├── layout.tsx          # root layout
│   ├── globals.css         # dark theme + player styles (live badge, spinner, go-live btn)
│   ├── page.tsx            # simple homepage — lists the routes below
│   ├── player/
│   │   └── page.tsx        # /player?url=<m3u8>  — the actual watch page
│   └── api/
│       ├── route.ts        # GET /api — health/info JSON
│       └── pwlive/
│           ├── player/route.ts    # GET /api/pwlive/player?url=<m3u8>
│           ├── download/route.ts  # GET /api/pwlive/download?url=<m3u8>
│           └── seg/route.ts       # GET /api/pwlive/seg?u=<token> (internal, used by player route)
└── lib/
    ├── cors.ts             # allow-all-origins CORS helper
    └── hlsProxy.ts         # upstream fetch (retry/timeout) + .m3u8 rewrite logic
```

## Routes

### `GET /api/pwlive/player?url=<m3u8-url>`
Fetches the given `index.m3u8` (any type — master or media playlist) and
rewrites every segment / nested-playlist reference to point back at
`/api/pwlive/seg?u=<token>` on this same domain. This is what the `/player`
page (via hls.js) loads — same-origin, no CORS issues, real CDN URL never
exposed to client JS.

- Missing `url` → `{ "error": "URL missing" }`, status `400`
- Upstream failure → `{ "error": "..." }` with the upstream's status (or `502`)
- CORS: `Access-Control-Allow-Origin: *` on every response, including errors

### `GET /api/pwlive/download?url=<m3u8-url>`
Returns a **download-friendly** playlist: every segment / nested-playlist
URL is rewritten to the real, **absolute CDN URL** (with the playlist's
signed auth params — `Signature`/`Policy`/`Key-Pair-Id`/etc. — copied onto
segments that need them), **not** proxied through this domain.

- Opening it directly plays the full playlist (all segments connected,
  in order) straight off the CDN.
- Handing this same link to a download manager (1DM, ADM, etc.) lets it
  pull every segment directly from the CDN in parallel.
- This route never saves/downloads anything server-side — it only returns
  a playlist. (Render's free tier has no persistent disk anyway.)

### `GET /player?url=<m3u8-url>`
The actual watch page. Default `<video controls>` — seek bar, volume,
fullscreen, back — all native/default, nothing custom there. Exactly two
extra overlays:
- **LIVE badge** (top-left, red bar + blinking dot) — shown only while the
  loaded playlist is actually live.
- **GO LIVE button** (top-right, tap-only) — appears only once you've
  seeked more than ~15s behind the live edge; tapping it jumps to the live
  edge. It never forces you back to live — rewinding/seeking works
  completely normally, and the button disappears again once you're back
  at the edge.

## Local dev

```bash
npm install
npm run dev
# open http://localhost:3000/player?url=<your-index.m3u8-url>
```

## Deploy on Render.com (Docker, free web service)

1. Push this repo to GitHub.
2. Render dashboard → **New** → **Web Service** → connect the repo.
3. Runtime: **Docker** (it'll auto-detect the `Dockerfile`).
4. Nothing else to configure — the Dockerfile hardcodes `PORT=8000` and
   `EXPOSE 8000`. Render's own routing works with any port your container
   listens on, so this is fine as-is.
5. Deploy. Your base URL will be `https://<your-app>.onrender.com`.

Usage once deployed:
- Player: `https://<your-app>.onrender.com/player?url=<index.m3u8-url>`
- Player API: `https://<your-app>.onrender.com/api/pwlive/player?url=<index.m3u8-url>`
- Download playlist: `https://<your-app>.onrender.com/api/pwlive/download?url=<index.m3u8-url>`

## Env vars

**None required.** This app is fully stateless — no database, no login, no
link-generation/storage — so there's nothing to configure for it to work.
It doesn't touch MongoDB at all; the whole flow is just: take the `?url=`
you pass in → fetch it → rewrite it → return it.

If you later want to reuse it for something that needs a DB again, add
your `MONGODB_URI` as a Render **Environment Variable** at that point —
just isn't needed for what this repo does today.

## Notes

- Everything is Node.js / Next.js — no `requirements.txt` here (that's a
  Python-project file); `package.json` + the `Dockerfile` is the Node
  equivalent and is all this repo needs.
- `bot.py`, `main.py`, `recorder.py`, the admin/login templates, the file
  store, and the MongoDB-backed link-generator system from the old repo
  are all gone — this is a clean, from-scratch, stateless proxy+player.
