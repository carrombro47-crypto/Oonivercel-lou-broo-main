# PW Live Proxy — Next.js (App Router) on Vercel

Poora purana system (login portal, MongoDB, link-generate bot, File Store
bot, Telegram upload/download pipeline) **hata diya gaya hai**. Ab ye sirf
ek **stateless HLS proxy + simple player** hai — koi login, koi database,
koi link-generation nahi. Sab kuch `?url=` query param se chalta hai.

## Folder structure

```
pwlive-next/
├── app/
│   ├── layout.tsx                          # root layout
│   ├── globals.css                         # minimal reset
│   ├── page.tsx                             # simple landing/info page ("/")
│   ├── player/
│   │   └── page.tsx                        # THE player page — "/player?url=..."
│   └── api/
│       ├── route.ts                        # GET /api — info route
│       ├── pwlive/
│       │   ├── player/route.ts             # GET /api/pwlive/player?url=
│       │   ├── seg/route.ts                # GET /api/pwlive/seg?u=  (internal, used by player route)
│       │   └── download/route.ts           # GET /api/pwlive/download?url=
│       └── live/
│           └── [title]/
│               └── playlist/route.ts       # GET /api/live/<title>/playlist?url=  (legacy-style alias)
├── lib/
│   ├── hlsProxy.ts                         # shared fetch + .m3u8 rewrite logic
│   └── cors.ts                             # allow-all CORS helper
├── package.json
├── tsconfig.json
├── next.config.mjs
├── next-env.d.ts
├── .env.example
└── .gitignore
```

## Routes

### 1) `GET /api/pwlive/player?url=<m3u8-url>`

Fetches the given `.m3u8`, rewrites every segment/nested-playlist URL to
point back at **this same domain** (`/api/pwlive/seg?u=<token>`), returns
the rewritten playlist. This is what the player page loads via hls.js —
same-origin, CORS-safe, real CDN URL never reaches client JS.

- Missing `url` → `{ "error": "URL missing" }`, status `400`.
- Upstream failure → `{ "error": "..." }`, matching status code.

### 2) `GET /api/pwlive/seg?u=<token>`

Internal helper used by the rewritten playlist from `/player` above —
relays one segment (`.ts`/`.m4s`) or a nested playlist (rewritten again,
recursively). You don't call this directly.

### 3) `GET /api/pwlive/download?url=<m3u8-url>`

Returns a **download-friendly** playlist — every segment URL is rewritten
to the **real, absolute CDN URL** (signed auth params like
Signature/Policy/Key-Pair-Id copied over) instead of being proxied through
this domain.

- Open this URL directly in a browser → full video plays, all segments
  properly connected (nothing downloaded/saved on the server).
- Paste the same URL into a download manager (**1DM**, ADM, etc.) → it
  downloads every segment **directly from the CDN in parallel** and stitches
  the complete video — full CDN speed, and it never routes potentially
  thousands of segment requests through a serverless function (which would
  be slow and hit Vercel's execution-time limits).

### 4) `GET /api/live/<title>/playlist?url=<m3u8-url>`

Kept exactly as requested — same behaviour as `/api/pwlive/player` (proxy
mode), just under the older `/api/live/<title>/playlist` path shape.
`<title>` is only a human-friendly label now (no database lookup — the
actual source is always the `?url=` param).

### 5) `GET /player?url=<m3u8-url>`

The actual watchable page. Deliberately plain (matches the reference
screenshot): a native `<video controls>` element (default seek bar,
volume, fullscreen — everything default) with hls.js underneath, plus
exactly two small overlays:

- **`● LIVE`** badge, top-left — shown only while the loaded playlist is
  actually live (no `#EXT-X-ENDLIST`).
- **`GO LIVE`** button, top-right — shown only once you've seeked more
  than ~15s behind the live edge; tapping it jumps back to live. It never
  force-jumps you to live — rewinding to watch from the start works
  completely normally, the button just disappears when you're already at
  the live edge (or when the stream isn't live at all).

## Env vars

**None required.** The whole app is stateless.

`.env.example` has one reserved-but-currently-unused line for a future
`MONGO_URI` (same `carrom47...` cluster you mentioned) — only wire it up
if you later want to add something like watch-history/analytics; nothing
in this codebase uses it right now.

## Local dev

```bash
npm install
npm run dev
# open http://localhost:3000
# player: http://localhost:3000/player?url=<url-encoded m3u8>
```

## Deploy on Vercel

1. Push this folder as a new GitHub repo (or upload directly).
2. Go to [vercel.com](https://vercel.com) → **Add New → Project** → import
   the repo.
3. Framework preset: **Next.js** (auto-detected). Leave build command /
   output directory as default.
4. No environment variables needed — just click **Deploy**.
5. Once deployed you'll get something like
   `https://your-project.vercel.app`. Use it as:
   - Watch: `https://your-project.vercel.app/player?url=<url-encoded m3u8>`
   - Download-friendly playlist:
     `https://your-project.vercel.app/api/pwlive/download?url=<url-encoded m3u8>`

**Note on Vercel Hobby plan limits:** each serverless function invocation
(one playlist fetch, or one segment relay) has a default execution timeout
(10s on Hobby, configurable higher on Pro) — this is per-request, not
per-video, so it's plenty for fetching one playlist or one segment. The
`/api/pwlive/download` route is specifically designed to avoid routing
whole-video downloads through serverless functions at all (see above) —
that's the CDN's job, not Vercel's.
