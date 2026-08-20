/**
 * lib/hlsProxy.ts
 * ────────────────────────────────────────────────────────────────────────
 * Core HLS (.m3u8) fetch + rewrite logic — shared by every route under
 * app/api/pwlive/* and app/api/live/[title]/playlist.
 *
 * Two rewrite modes:
 *   - "proxy"  → every segment / nested-playlist URL is rewritten to point
 *                back at OUR OWN domain (/api/pwlive/seg?u=<token>).
 *
 *   - "direct" → every segment / nested-playlist URL is rewritten to an
 *                ABSOLUTE real CDN url with the playlist's signed-CDN auth
 *                params copied onto it.
 */

// A generic modern browser User-Agent + a few extra client-hint headers.
export const UPSTREAM_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",

  Accept: "*/*",

  "Accept-Language": "en-US,en;q=0.9",

  Referer: "https://www.pw.live/",

  Origin: "https://www.pw.live",

  "sec-ch-ua": '"Chromium";v="126", "Not_A Brand";v="8"',

  "sec-ch-ua-mobile": "?0",

  "sec-ch-ua-platform": '"Windows"',
};


// Query-param names (case-insensitive) that are CDN signed-URL auth
// tokens. These are copied from the playlist URL onto same-host segment
// URLs that don't already carry them.
const AUTH_PARAMS = new Set([
  "signature",
  "policy",
  "key-pair-id",
  "expires",
  "start",
  "session-id",
]);


const UPSTREAM_TIMEOUT_MS = 15_000;

const UPSTREAM_MAX_RETRIES = 2;


// ────────────────────────────────────────────────────────────────────────
// URL PARAM EXTRACTOR
// ────────────────────────────────────────────────────────────────────────
//
// Supports:
//
//   /api/...?...url=https://example.com/index.m3u8
//   /api/...?...u=https://example.com/index.m3u8
//
// Also accepts Request / URL / string so it can be safely reused by
// different Next.js API routes.
// ────────────────────────────────────────────────────────────────────────

export function extractUrlParam(
  input: Request | URL | string
): string {
  let url: URL;

  if (input instanceof URL) {
    url = input;
  } else if (typeof input === "string") {
    try {
      url = new URL(input);
    } catch {
      // If the supplied string itself is already an URL, return it.
      return input.trim();
    }
  } else {
    url = new URL(input.url);
  }

  // Preferred parameter.
  const u = url.searchParams.get("u");

  if (u && u.trim()) {
    return u.trim();
  }

  // Common fallback used by API routes.
  const targetUrl = url.searchParams.get("url");

  if (targetUrl && targetUrl.trim()) {
    return targetUrl.trim();
  }

  // Additional common aliases.
  const src = url.searchParams.get("src");

  if (src && src.trim()) {
    return src.trim();
  }

  const source = url.searchParams.get("source");

  if (source && source.trim()) {
    return source.trim();
  }

  throw new Error(
    "Missing required URL parameter. Expected ?u=, ?url=, ?src= or ?source="
  );
}


// ────────────────────────────────────────────────────────────────────────
// BASE64URL HELPERS
// ────────────────────────────────────────────────────────────────────────

export function b64urlEncode(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64url");
}


export function b64urlDecode(s: string): string {
  return Buffer.from(s, "base64url").toString("utf-8");
}


// ────────────────────────────────────────────────────────────────────────
// UPSTREAM FETCH
// ────────────────────────────────────────────────────────────────────────
//
// Retry behavior:
//   - 2xx → final
//   - 4xx → final
//   - 5xx → retry
//   - network / timeout → retry
// ────────────────────────────────────────────────────────────────────────

export async function fetchUpstream(
  url: string,
  rangeHeader?: string | null
): Promise<Response> {
  const headers: Record<string, string> = {
    ...UPSTREAM_HEADERS,
  };

  if (rangeHeader) {
    headers["Range"] = rangeHeader;
  }

  let lastErr: unknown = null;

  for (
    let attempt = 0;
    attempt <= UPSTREAM_MAX_RETRIES;
    attempt++
  ) {
    const controller = new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      UPSTREAM_TIMEOUT_MS
    );

    try {
      const res = await fetch(url, {
        headers,
        redirect: "follow",
        signal: controller.signal,
        cache: "no-store",
      });

      clearTimeout(timer);

      // 2xx or 4xx = final response.
      if (
        res.ok ||
        (res.status >= 400 && res.status < 500)
      ) {
        return res;
      }

      // 5xx → retry.
      lastErr = new Error(`Upstream ${res.status}`);
    } catch (e) {
      clearTimeout(timer);

      lastErr = e;
    }

    if (attempt < UPSTREAM_MAX_RETRIES) {
      await new Promise((resolve) =>
        setTimeout(resolve, 300 * (attempt + 1))
      );
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error("Upstream fetch failed");
}


// ────────────────────────────────────────────────────────────────────────
// COPY AUTH PARAMS FROM PLAYLIST URL
// ────────────────────────────────────────────────────────────────────────

function inheritAuthParams(
  segUrl: string,
  playlistUrl: string
): string {
  try {
    const seg = new URL(segUrl);

    const pl = new URL(playlistUrl);

    // Only inherit auth params for the same CDN host.
    if (seg.host !== pl.host) {
      return segUrl;
    }

    const segKeysLower = new Set(
      Array.from(seg.searchParams.keys()).map((k) =>
        k.toLowerCase()
      )
    );

    for (const [k, v] of pl.searchParams.entries()) {
      const keyLower = k.toLowerCase();

      if (
        AUTH_PARAMS.has(keyLower) &&
        !segKeysLower.has(keyLower)
      ) {
        seg.searchParams.append(k, v);
      }
    }

    return seg.toString();
  } catch {
    return segUrl;
  }
}


// ────────────────────────────────────────────────────────────────────────
// REWRITE OPTIONS
// ────────────────────────────────────────────────────────────────────────

export type RewriteOpts =
  | {
      mode: "proxy";
      origin: string;
    }
  | {
      mode: "direct";
    };


// ────────────────────────────────────────────────────────────────────────
// M3U8 REWRITER
// ────────────────────────────────────────────────────────────────────────
//
// Handles:
//
//   - normal .ts segments
//   - nested .m3u8 playlists
//   - #EXT-X-KEY URI="..."
//   - #EXT-X-MAP URI="..."
//   - other URI="..." attributes
// ────────────────────────────────────────────────────────────────────────

export function rewriteM3U8(
  body: string,
  playlistUrl: string,
  opts: RewriteOpts
): string {
  const lines = body.split(/\r?\n/);

  const out: string[] = [];

  const transform = (raw: string): string => {
    const cleaned = raw.trim();

    if (!cleaned) {
      return cleaned;
    }

    let absolute: string;

    try {
      absolute = new URL(
        cleaned,
        playlistUrl
      ).toString();
    } catch {
      // Keep malformed references unchanged rather than crashing
      // the entire playlist rewrite.
      return raw;
    }

    const withAuth = inheritAuthParams(
      absolute,
      playlistUrl
    );

    // DIRECT MODE
    //
    // Browser/download manager goes directly to CDN.
    if (opts.mode === "direct") {
      return withAuth;
    }

    // PROXY MODE
    //
    // Hide the actual CDN URL behind our own endpoint.
    const token = b64urlEncode(withAuth);

    return `${opts.origin}/api/pwlive/seg?u=${token}`;
  };


  for (const line of lines) {
    const t = line.trim();

    // Empty line.
    if (!t) {
      out.push(line);
      continue;
    }


    // M3U8 directive.
    if (t.startsWith("#")) {
      // Rewrite URI="..." attributes.
      //
      // Examples:
      // #EXT-X-KEY:METHOD=AES-128,URI="key.key"
      // #EXT-X-MAP:URI="init.mp4"
      //
      if (/URI="/i.test(t)) {
        out.push(
          line.replace(
            /URI="([^"]+)"/gi,
            (_match, p1) =>
              `URI="${transform(p1)}"`
          )
        );
      } else {
        out.push(line);
      }

      continue;
    }


    // Normal segment / nested playlist URL.
    out.push(transform(t));
  }


  return out.join("\n") + "\n";
}


// ────────────────────────────────────────────────────────────────────────
// M3U8 DETECTION
// ────────────────────────────────────────────────────────────────────────
//
// Detects by:
//   - Content-Type
//   - .m3u8 extension
// ────────────────────────────────────────────────────────────────────────

export function looksLikeM3U8(
  url: string,
  contentType?: string | null
): boolean {
  const ctype = (
    contentType || ""
  ).toLowerCase();


  if (
    ctype.includes("mpegurl") ||
    ctype.includes("m3u8")
  ) {
    return true;
  }


  try {
    return new URL(url)
      .pathname
      .toLowerCase()
      .endsWith(".m3u8");
  } catch {
    return url
      .toLowerCase()
      .split("?")[0]
      .endsWith(".m3u8");
  }
}
